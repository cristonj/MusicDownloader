"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Plus, RotateCw, Search, X } from "lucide-react";
import { durationLabel, type Provider } from "@/lib/model";
import {
  FEED_PROVIDERS,
  loadFeed,
  type FeedColumn,
  type FeedRow,
} from "@/lib/feed";
interface ColumnState {
  column?: FeedColumn;
  error?: string;
  loading: boolean;
}
const slug = (provider: Provider) =>
  provider.toLowerCase().replace(/\s+/g, "-");
// Each service answers at its own speed, so every column loads on its own and
// says for itself whether it has a chart, a search, or neither.
export default function Feed({
  add,
  busy,
  icon,
}: {
  add: (row: FeedRow, provider: Provider) => Promise<boolean>;
  busy: boolean;
  icon: (provider: Provider) => React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [columns, setColumns] = useState<Record<string, ColumnState>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const requests = useRef(new Map<string, AbortController>());
  const load = useCallback((provider: Provider, term: string) => {
    requests.current.get(provider)?.abort();
    const controller = new AbortController();
    requests.current.set(provider, controller);
    setColumns((state) => ({ ...state, [provider]: { loading: true } }));
    loadFeed(provider, term, controller.signal)
      .then((column) =>
        setColumns((state) => ({
          ...state,
          [provider]: { column, loading: false },
        })),
      )
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setColumns((state) => ({
          ...state,
          [provider]: { error: error.message, loading: false },
        }));
      });
  }, []);
  useEffect(() => {
    for (const provider of FEED_PROVIDERS) load(provider, search);
    const pending = requests.current;
    return () => {
      for (const controller of pending.values()) controller.abort();
    };
  }, [search, load]);
  return (
    <section className="feed" aria-label="Service feeds">
      <div className="feed-head">
        <div>
          <strong>
            {search ? `Results for “${search}”` : "Top songs right now"}
          </strong>
          <p>
            Each service&apos;s own public chart, or one search across all of
            them. Add a row to put it in your collection.
          </p>
        </div>
        <form
          className="feed-search"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(query.trim());
          }}
        >
          <Search size={15} />
          <input
            aria-label="Search every service"
            placeholder="Search every service…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                setSearch("");
              }}
            >
              <X size={14} />
            </button>
          )}
          <button type="submit" className="feed-search-go">
            Search
          </button>
        </form>
      </div>
      <div className="feed-columns">
        {FEED_PROVIDERS.map((provider) => {
          const state = columns[provider] || { loading: true };
          return (
            <article
              key={provider}
              className={`feed-column provider-${slug(provider)}`}
            >
              <header>
                <span className="feed-mark">{icon(provider)}</span>
                <div>
                  <strong>{provider}</strong>
                  <small>
                    {state.column?.title || (search ? "Search" : "Chart")}
                  </small>
                </div>
                {!state.loading && (
                  <button
                    className="feed-refresh"
                    onClick={() => load(provider, search)}
                    aria-label={`Reload ${provider}`}
                  >
                    <RotateCw size={12} />
                  </button>
                )}
              </header>
              {state.loading && (
                <p className="feed-note">
                  <LoaderCircle size={13} className="spin" /> Loading…
                </p>
              )}
              {state.error && (
                <p className="feed-note feed-error">{state.error}</p>
              )}
              <ol>
                {state.column?.rows.map((row, index) => {
                  const id = `${provider}:${index}:${row.title}`;
                  return (
                    <li key={id}>
                      <span className="feed-rank">{index + 1}</span>
                      <span className="feed-track">
                        <strong title={row.title}>{row.title}</strong>
                        <small title={row.artist}>
                          {row.artist || "Unknown artist"}
                          {row.duration
                            ? ` · ${durationLabel(row.duration)}`
                            : ""}
                        </small>
                      </span>
                      <button
                        aria-label={`Add ${row.title} from ${provider}`}
                        disabled={busy || adding === id || added.includes(id)}
                        onClick={async () => {
                          setAdding(id);
                          const ok = await add(row, provider);
                          setAdding(null);
                          if (ok) setAdded((items) => [...items, id]);
                        }}
                      >
                        {added.includes(id) ? (
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
            </article>
          );
        })}
      </div>
    </section>
  );
}
