"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  bytesLabel,
  defaults,
  MAX_BATCH_BYTES,
  MAX_TRACKS,
  outputFilename,
  readPreferences,
  safeFilename,
  type Preferences,
  type Track,
} from "@/lib/model";
import { fetchAudio, localTrack, resolveLink } from "@/lib/sources";
import {
  consumeHelperPair,
  helperConnection,
  helperFetch,
  helperOutdated,
  HelperRequiredError,
} from "@/lib/helper";
import { cancelConversion, convertAudio, makeZip, saveBlob } from "@/lib/audio";

export function useLibrary() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [prefs, setPrefs] = useState<Preferences>(defaults);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    done: number;
    total: number;
    label: string;
  } | null>(null);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState<{
    text: string;
    kind: "error" | "info" | "success";
  } | null>(null);
  const [helperOpen, setHelperOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collection, setCollection] = useState("Your collection");
  const current = useRef<Track[]>([]);
  const running = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const resolveAbort = useRef<AbortController | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  current.current = tracks;

  useEffect(() => {
    try {
      if (consumeHelperPair()) setHelperOpen(true);
      else if (helperConnection())
        helperFetch("/health", { signal: AbortSignal.timeout(5000) })
          .then((response) => response.json())
          .then((health) => {
            if (helperOutdated(health)) setHelperOpen(true);
          })
          .catch(() => {});
      const saved = readPreferences(
        localStorage.getItem("music-downloader:preferences"),
      );
      setPrefs(saved);
    } catch {
      /* Private browsing can disable localStorage. */
    }
    setHydrated(true);
    return () => {
      abort.current?.abort();
      resolveAbort.current?.abort();
      cancelConversion();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);
  useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem(
          "music-downloader:preferences",
          JSON.stringify(prefs),
        );
      } catch {
        /* Preferences still work in memory. */
      }
    }
  }, [prefs, hydrated]);
  const notify = useCallback(
    (text: string, kind: "error" | "info" | "success" = "info") => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setNotice({ text, kind });
      noticeTimer.current = setTimeout(
        () => setNotice(null),
        kind === "error" ? 18000 : 12000,
      );
    },
    [],
  );
  const patch = useCallback(
    (id: string, update: Partial<Track>) =>
      setTracks((items) =>
        items.map((item) => (item.id === id ? { ...item, ...update } : item)),
      ),
    [],
  );
  const changePrefs = (update: Partial<Preferences>) => {
    if (running.current) return;
    setPrefs((p) => ({ ...p, ...update }));
    if (Object.keys(update).length > 0)
      setTracks((items) =>
        items.map((t) => ({
          ...t,
          output: undefined,
          outputName: undefined,
          status: t.file || t.mediaUrl ? "ready" : "error",
          progress: 0,
          error: t.file || t.mediaUrl ? undefined : t.error,
        })),
      );
  };
  const addFiles = (files: FileList | File[]) => {
    if (running.current || resolveAbort.current) return;
    const accepted: Track[] = [];
    const errors: string[] = [];
    let size = current.current.reduce(
      (sum, track) => sum + (track.file?.size || 0) + (track.output?.size || 0),
      0,
    );
    for (const file of Array.from(files)) {
      try {
        if (current.current.length + accepted.length >= MAX_TRACKS)
          throw new Error(`Add up to ${MAX_TRACKS} tracks at a time.`);
        if (size + file.size > MAX_BATCH_BYTES)
          throw new Error(
            "This collection exceeds the 450 MB browser memory limit. Clear some tracks first.",
          );
        const track = localTrack(file);
        accepted.push(track);
        size += file.size;
      } catch (error) {
        errors.push((error as Error).message);
      }
    }
    setTracks((items) => [...items, ...accepted]);
    if (errors.length) notify(errors[0], "error");
    else if (accepted.length) setNotice(null);
  };
  const addLink = async (link: string) => {
    if (resolveAbort.current || running.current || !link.trim()) return false;
    const controller = new AbortController();
    resolveAbort.current = controller;
    setResolving(true);
    setImportProgress(null);
    setNotice(null);
    try {
      const result = await resolveLink(
        link,
        controller.signal,
        (done, total, label) => setImportProgress({ done, total, label }),
      );
      if (current.current.length + result.tracks.length > MAX_TRACKS)
        throw new Error(
          `Keep your collection under ${MAX_TRACKS} tracks. Clear it to import this playlist.`,
        );
      setTracks((items) => [...items, ...result.tracks]);
      setCollection(result.title);
      if (result.notice) notify(result.notice, "error");
      else if (result.tracks.some((t) => t.provider === "Spotify"))
        notify(
          "Spotify imported. Confident matches are selected; review the rest before downloading.",
        );
      return true;
    } catch (error) {
      if (error instanceof HelperRequiredError) setHelperOpen(true);
      notify(
        controller.signal.aborted
          ? "Import cancelled."
          : (error as Error).message,
        "error",
      );
      return false;
    } finally {
      resolveAbort.current = null;
      setResolving(false);
      setImportProgress(null);
    }
  };
  const cancel = () => {
    abort.current?.abort();
    resolveAbort.current?.abort();
    cancelConversion();
  };
  const download = async (ids: string[], zip: boolean) => {
    if (running.current || resolveAbort.current) return;
    const selected = current.current.filter((t) => ids.includes(t.id));
    if (!selected.length) return;
    running.current = true;
    setBusy(true);
    setNotice(null);
    const controller = new AbortController();
    abort.current = controller;
    const signal = controller.signal;
    const results: { name: string; blob: Blob }[] = [];
    let failures = 0;
    let memory = current.current.reduce(
      (sum, t) => sum + (t.file?.size || 0) + (t.output?.size || 0),
      0,
    );
    try {
      // Six transfers stream continuously while one WASM conversion runs at a
      // time, so a slow track or conversion never stalls the other downloads.
      const fetchOne = async (track: Track) => {
        if (signal.aborted) return null;
        if (track.output)
          return {
            blob: track.output,
            extension: track.extension,
            remuxTo: undefined as string | undefined,
          };
        patch(track.id, {
          status: "fetching",
          error: undefined,
          progress: 0,
        });
        setStatus(`Fetching ${track.title}…`);
        try {
          const data = await fetchAudio(track, signal, (value) =>
            patch(track.id, {
              progress: value * (prefs.format === "original" ? 0.99 : 0.35),
            }),
          );
          if (!track.file) {
            memory += data.blob.size;
            if (memory > MAX_BATCH_BYTES) {
              memory -= data.blob.size;
              throw new Error(
                "Browser memory limit reached. Export a smaller selection.",
              );
            }
          }
          patch(track.id, { extension: data.extension });
          return data;
        } catch (error) {
          if (error instanceof HelperRequiredError) setHelperOpen(true);
          if (!signal.aborted) {
            patch(track.id, {
              status: "error",
              error: (error as Error).message,
            });
            failures++;
          }
          return null;
        }
      };
      const convertOne = async (
        source: Track,
        fetched: NonNullable<Awaited<ReturnType<typeof fetchOne>>>,
      ) => {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const track = { ...source, extension: fetched.extension },
          input = fetched.blob;
        try {
          let output = track.output;
          if (!output) {
            if (prefs.format !== "original" || fetched.remuxTo)
              patch(track.id, { status: "converting", progress: 0.35 });
            output = await convertAudio(
              input,
              track,
              prefs,
              signal,
              (value) => patch(track.id, { progress: 0.35 + value * 0.65 }),
              setStatus,
              fetched.remuxTo,
            );
            if (signal.aborted)
              throw new DOMException("Cancelled", "AbortError");
            if (output !== input)
              memory += output.size - (track.file ? 0 : input.size);
            if (memory > MAX_BATCH_BYTES)
              throw new Error(
                "Converted audio exceeds the browser memory limit. Try a smaller selection.",
              );
          }
          const name =
            track.outputName ||
            outputFilename(
              {
                ...track,
                extension:
                  prefs.format === "original"
                    ? fetched.remuxTo || track.extension
                    : track.extension,
              },
              prefs.format,
            );
          patch(track.id, {
            status: "done",
            extension:
              prefs.format === "original"
                ? fetched.remuxTo || track.extension
                : track.extension,
            output,
            outputName: name,
            progress: 1,
          });
          results.push({ name, blob: output });
        } catch (error) {
          if (signal.aborted) throw error;
          patch(track.id, {
            status: "error",
            error: (error as Error).message,
          });
          failures++;
        }
      };
      let next = 0,
        conversions: Promise<unknown> = Promise.resolve();
      await Promise.all(
        Array.from({ length: Math.min(6, selected.length) }, async () => {
          while (next < selected.length && !signal.aborted) {
            const track = selected[next++];
            const fetched = await fetchOne(track);
            if (!fetched) continue;
            const turn = conversions.then(() => convertOne(track, fetched));
            conversions = turn.catch(() => {});
            await turn;
          }
        }),
      );
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (!results.length) {
        notify(
          "No tracks were exported. Check the error beside each track and try again.",
          "error",
        );
        return;
      }
      if (zip) {
        setStatus("Packing your ZIP on this device…");
        const blob = await makeZip(results, signal);
        saveBlob(
          blob,
          `${collection === "Your collection" ? "MusicDownloader" : safeFilename(collection)}.zip`,
        );
        notify(
          `${results.length} track${results.length === 1 ? "" : "s"} · ${bytesLabel(blob.size)} · ZIP saved${failures ? `. ${failures} track(s) failed; only successful tracks are included.` : "."}`,
          failures ? "error" : "success",
        );
      } else {
        saveBlob(results[0].blob, results[0].name);
        notify("Your download is ready.", "success");
      }
    } catch (error) {
      notify(
        signal.aborted
          ? "Export cancelled. Completed tracks are kept."
          : (error as Error).message,
        signal.aborted ? "info" : "error",
      );
    } finally {
      setTracks((items) =>
        items.map((t) =>
          ["fetching", "converting"].includes(t.status)
            ? { ...t, status: "ready", progress: 0 }
            : t,
        ),
      );
      running.current = false;
      abort.current = null;
      setBusy(false);
      setStatus("");
    }
  };
  return {
    tracks,
    prefs,
    busy,
    resolving,
    importProgress,
    status,
    notice,
    settingsOpen,
    helperOpen,
    setHelperOpen,
    collection,
    hydrated,
    setSettingsOpen,
    setNotice,
    changePrefs,
    addFiles,
    addLink,
    cancel,
    download,
    select: (id: string) => {
      if (!running.current)
        setTracks((items) =>
          items.map((t) => (t.id === id ? { ...t, selected: !t.selected } : t)),
        );
    },
    selectAll: () => {
      if (!running.current)
        setTracks((items) =>
          items.map((t) => ({
            ...t,
            selected:
              Boolean(t.file || t.mediaUrl) &&
              !items
                .filter((item) => item.file || item.mediaUrl)
                .every((item) => item.selected),
          })),
        );
    },
    remove: (id: string) => {
      if (!running.current)
        setTracks((items) => items.filter((t) => t.id !== id));
    },
    clear: () => {
      if (!running.current) {
        setTracks([]);
        setCollection("Your collection");
      }
    },
    notify,
  };
}
