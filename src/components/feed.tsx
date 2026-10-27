"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  LoaderCircle,
  Maximize2,
  Plus,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { durationLabel, type Provider } from "@/lib/model";
import {
  FEED_PROVIDERS,
  loadFeed,
  type FeedColumn,
  type FeedRow,
} from "@/lib/feed";
const COLUMN_ROWS = 25;
const FOCUS_ROWS = 60;
interface ColumnState {
  column?: FeedColumn;
  error?: string;
  loading: boolean;
  size: number;
}
export const providerSlug = (provider: Provider) =>
  provider.toLowerCase().replace(/\s+/g, "-");
// Cover art comes from the services' own image CDNs; a song without one keeps
// its place in the list with its initial rather than an empty frame.
function Artwork({ row, provider }: { row: FeedRow; provider: Provider }) {
  const [failed, setFailed] = useState(false);
  if (!row.artwork || failed)
    return (
      <span className="feed-art feed-art-blank" aria-hidden="true">
        {(row.title || "?").trim().charAt(0).toUpperCase()}
      </span>
    );
  return (
    <img
      className="feed-art"
      src={row.artwork}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      data-provider={providerSlug(provider)}
    />
  );
}
export default function Feed({
  add,
  busy,
  icon,
  hidden,
  setHidden,
}: {
  add: (row: FeedRow, provider: Provider) => Promise<boolean>;
  busy: boolean;
  icon: (provider: Provider) => React.ReactNode;
  hidden: Provider[];
  setHidden: (providers: Provider[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [focused, setFocused] = useState<Provider | null>(null);
  const [columns, setColumns] = useState<Record<string, ColumnState>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const requests = useRef(new Map<string, AbortController>());
  const load = useCallback((provider: Provider, term: string, size: number) => {
    requests.current.get(provider)?.abort();
    const controller = new AbortController();
    requests.current.set(provider, controller);
    setColumns((state) => ({
      ...state,
      [provider]: { ...state[provider], loading: true, size },
    }));
    loadFeed(provider, term, size, controller.signal)
      .then((column) =>
        setColumns((state) => ({
          ...state,
          [provider]: { column, loading: false, size },
        })),
      )
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setColumns((state) => ({
          ...state,
          [provider]: { error: error.message, loading: false, size },
        }));
      });
  }, []);
  const shown = focused
    ? [focused]
    : FEED_PROVIDERS.filter((provider) => !hidden.includes(provider));
  useEffect(() => {
    const size = focused ? FOCUS_ROWS : COLUMN_ROWS;
    for (const provider of shown) {
      const state = columns[provider];
      if (!state || (!state.loading && state.size !== size)) {
        load(provider, search, size);
      }
    }
    // Columns are loaded as they are revealed; the effect only reacts to the
    // search, the focused service, and which services are shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, focused, hidden.join(","), load]);
  useEffect(() => {
    const pending = requests.current;
    return () => {
      for (const controller of pending.values()) controller.abort();
    };
  }, []);
  const runSearch = (term: string) => {
    setColumns({});
    setSearch(term);
  };
  const toggleHidden = (provider: Provider) =>
    setHidden(
      hidden.includes(provider)
        ? hidden.filter((item) => item !== provider)
        : [...hidden, provider],
    );
  return (
    <section
      className={`feed ${focused ? "feed-focused" : ""}`}
      aria-label="Service feeds"
    >
      <div className="feed-head">
        <div className="feed-title">
          <h2>{search ? `“${search}”` : "Charts"}</h2>
          <p>
            {focused
              ? `Everything ${focused} publishes for this list.`
              : search
                ? "The same search, run on every service that publishes one."
                : "What each service is playing right now, side by side."}
          </p>
        </div>
        <form
          className="feed-search"
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(query.trim());
          }}
        >
          <Search size={16} />
          <input
            aria-label="Search every service"
            placeholder="Search every service…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {(search || query) && (
            <button
              type="button"
              className="feed-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                if (search) runSearch("");
              }}
            >
              <X size={14} />
            </button>
          )}
          <button type="submit" className="feed-go">
            Search
          </button>
        </form>
      </div>
      <div className="feed-filters">
        {focused ? (
          <button className="feed-back" onClick={() => setFocused(null)}>
            <ArrowLeft size={14} /> All services
          </button>
        ) : (
          FEED_PROVIDERS.map((provider) => (
            <button
              key={provider}
              className={`feed-pill provider-${providerSlug(provider)} ${hidden.includes(provider) ? "off" : ""}`}
              onClick={() => toggleHidden(provider)}
              aria-pressed={!hidden.includes(provider)}
            >
              <span className="feed-dot" />
              {provider}
            </button>
          ))
        )}
      </div>
      <div className="feed-grid">
        {shown.map((provider) => {
          const state = columns[provider] || {
            loading: true,
            size: COLUMN_ROWS,
          };
          const rows = state.column?.rows || [];
          return (
            <article
              key={provider}
              className={`feed-card provider-${providerSlug(provider)} ${
                state.error ? "feed-card-short" : ""
              }`}
            >
              <header>
                <span className="feed-mark">{icon(provider)}</span>
                <div className="feed-card-title">
                  <strong>{provider}</strong>
                  <small>
                    {state.column?.title ||
                      (state.error
                        ? "Unavailable"
                        : search
                          ? "Searching…"
                          : "Loading…")}
                    {rows.length ? ` · ${rows.length} tracks` : ""}
                  </small>
                </div>
                <div className="feed-card-actions">
                  <button
                    aria-label={`Reload ${provider}`}
                    title="Reload"
                    onClick={() =>
                      load(provider, search, focused ? FOCUS_ROWS : COLUMN_ROWS)
                    }
                  >
                    <RotateCw size={13} />
                  </button>
                  {!focused && (
                    <>
                      <button
                        aria-label={`Show more from ${provider}`}
                        title="Show more"
                        onClick={() => setFocused(provider)}
                      >
                        <Maximize2 size={13} />
                      </button>
                      <button
                        aria-label={`Hide ${provider}`}
                        title="Hide"
                        onClick={() => toggleHidden(provider)}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </>
                  )}
                </div>
              </header>
              {state.loading && (
                <div className="feed-skeletons" aria-hidden="true">
                  {Array.from({ length: focused ? 8 : 5 }, (_, index) => (
                    <span key={index} />
                  ))}
                </div>
              )}
              {state.error && (
                <div className="feed-message">
                  <p>{state.error}</p>
                  {!search && (
                    <button
                      onClick={() => {
                        setQuery("");
                        setFocused(provider);
                      }}
                    >
                      Search {provider} instead
                    </button>
                  )}
                </div>
              )}
              {!state.loading && !state.error && (
                <ol>
                  {rows.map((row, index) => {
                    const id = `${provider}:${index}:${row.title}`;
                    const done = added.includes(id);
                    return (
                      <li key={id}>
                        <span className="feed-rank">{index + 1}</span>
                        <Artwork row={row} provider={provider} />
                        <span className="feed-names">
                          <strong title={row.fullTitle || row.title}>
                            {row.title}
                          </strong>
                          <small>{row.artist || "Unknown artist"}</small>
                        </span>
                        <span className="feed-time">
                          {row.duration ? durationLabel(row.duration) : ""}
                        </span>
                        <button
                          className={`feed-add ${done ? "done" : ""}`}
                          aria-label={`Add ${row.title} from ${provider}`}
                          disabled={busy || adding === id || done}
                          onClick={async () => {
                            setAdding(id);
                            const ok = await add(row, provider);
                            setAdding(null);
                            if (ok) setAdded((items) => [...items, id]);
                          }}
                        >
                          {done ? (
                            <Check size={14} />
                          ) : adding === id ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <Plus size={14} />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </article>
          );
        })}
      </div>
      {!focused && hidden.length > 0 && (
        <div className="feed-hidden">
          {hidden.length} hidden ·{" "}
          <button onClick={() => setHidden([])}>Show all</button>
        </div>
      )}
    </section>
  );
}
