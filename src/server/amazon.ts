import { HttpError } from "./security";
import { publicFetch } from "./upstream";
import { MAX_TRACKS } from "@/lib/model";
import type { MetadataTrack } from "./apple";
interface Credit {
  name?: string;
  joinphrase?: string;
}
interface Recording {
  title?: string;
  length?: number;
  "artist-credit"?: Credit[];
}
interface Release {
  id?: string;
  title?: string;
  "artist-credit"?: Credit[];
  media?: { tracks?: Recording[] }[];
}
interface Relation {
  "target-type"?: string;
  release?: Release;
  recording?: Recording;
}
// MusicBrainz asks every client to identify itself and to stay under one
// request a second; it answers 503 when busy.
const AGENT =
  "MusicDownloader/1.0 (https://github.com/cristonj/MusicDownloader)";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastCall = 0;
async function musicbrainz<T>(path: string): Promise<T | null> {
  const url = `https://musicbrainz.org/ws/2/${path}${path.includes("?") ? "&" : "?"}fmt=json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    // One request a second, as the database asks of every client.
    await pause(Math.max(0, lastCall + 1000 - Date.now()));
    lastCall = Date.now();
    const response = await publicFetch(url, {
      headers: { "User-Agent": AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status === 503 || response.status === 429) {
      await response.body?.cancel();
      await pause(1200 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(
        502,
        "The public music database is unavailable. Try this Amazon Music link again shortly.",
      );
    }
    return (await response.json().catch(() => null)) as T | null;
  }
  throw new HttpError(
    503,
    "The public music database is busy. Try this Amazon Music link again shortly.",
  );
}
const credited = (credits?: Credit[]) =>
  (credits || [])
    .map((credit) => `${credit.name || ""}${credit.joinphrase || ""}`)
    .join("")
    .trim();
const recordingTrack = (
  recording: Recording,
  fallbackArtist = "",
): MetadataTrack => ({
  title: (recording.title || "Untitled").slice(0, 300),
  artist: (credited(recording["artist-credit"]) || fallbackArtist).slice(
    0,
    200,
  ),
  duration:
    typeof recording.length === "number" ? recording.length / 1000 : undefined,
});
// Amazon Music's pages are a signed-in player that publishes no public track
// list, so its links are identified by the ASIN they carry. MusicBrainz
// catalogues those links publicly, which gives the names to match on YouTube.
async function relationsFor(asin: string, kind: "release" | "recording") {
  // The database records the canonical Amazon Music link; the same ASIN also
  // appears as an Amazon product link.
  const links = [
    `https://music.amazon.com/${kind === "release" ? "albums" : "tracks"}/${asin}`,
    `https://www.amazon.com/dp/${asin}`,
  ];
  for (const link of links) {
    const found = await musicbrainz<{ relations?: Relation[] }>(
      `url/?resource=${link}&inc=${kind}-rels`,
    );
    const relations = (found?.relations || []).filter(
      (relation) => relation["target-type"] === kind,
    );
    if (relations.length) return relations;
  }
  return [];
}
export async function amazonMusicMetadata(
  value: string,
): Promise<{ title: string; tracks: MetadataTrack[]; notice?: string }> {
  const url = new URL(value);
  const path = url.pathname.match(
    /^\/(albums|tracks|playlists|user-playlists)\/([A-Z0-9]{10})\/?$/,
  );
  if (!path)
    throw new HttpError(
      400,
      "Use an Amazon Music song or album link, such as music.amazon.com/albums/B0….",
    );
  const [, kind, asin] = path;
  // Share links for one song of an album name it in the query.
  const trackAsin = url.searchParams.get("trackAsin") || "";
  if (kind === "albums" && /^[A-Z0-9]{10}$/.test(trackAsin)) {
    const [relation] = await relationsFor(trackAsin, "recording");
    if (relation?.recording) {
      const track = recordingTrack(relation.recording);
      return { title: track.title, tracks: [track] };
    }
  }
  if (kind === "playlists" || kind === "user-playlists")
    throw new HttpError(
      422,
      "Amazon Music keeps playlist track lists behind a sign-in, so they cannot be imported. Import the albums or songs, or paste an Apple Music or Spotify playlist.",
    );
  if (kind === "tracks") {
    const [relation] = await relationsFor(asin, "recording");
    if (!relation?.recording)
      throw new HttpError(
        422,
        "This Amazon Music song is not listed in the public music database, so its name cannot be read. Paste the song's Apple Music or Spotify link instead.",
      );
    const track = recordingTrack(relation.recording);
    return { title: track.title, tracks: [track] };
  }
  const [relation] = await relationsFor(asin, "release");
  const id = relation?.release?.id;
  if (!id)
    throw new HttpError(
      422,
      "This Amazon Music album is not listed in the public music database, so its track list cannot be read. Paste the album's Apple Music or Spotify link instead.",
    );
  const release = await musicbrainz<Release>(
    `release/${id}?inc=recordings+artist-credits`,
  );
  const tracks = (release?.media || []).flatMap(
    (medium) => medium.tracks || [],
  );
  if (!tracks.length)
    throw new HttpError(
      422,
      "The public music database lists no tracks for this Amazon Music album.",
    );
  if (tracks.length > MAX_TRACKS)
    throw new HttpError(422, `Import up to ${MAX_TRACKS} tracks at a time.`);
  const albumArtist = credited(release?.["artist-credit"]);
  return {
    title: release?.title || "Amazon Music",
    tracks: tracks.map((track) => recordingTrack(track, albumArtist)),
  };
}
