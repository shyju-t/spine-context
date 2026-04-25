import { useState } from "react";
import { ConflictQueue } from "./components/ConflictQueue";
import { Header } from "./components/Header";
import { HomeIntro } from "./components/HomeIntro";
import { SearchBar } from "./components/SearchBar";
import { EntityPage } from "./components/EntityPage";
import { SearchResults } from "./components/SearchResults";
import { SourceViewer } from "./components/SourceViewer";

type View =
  | { kind: "home" }
  | { kind: "search"; query: string }
  | { kind: "entity"; query: string }
  | { kind: "conflicts" };

interface OpenSource {
  id: string;
  highlight?: [number, number];
}

export default function App() {
  const [roles, setRoles] = useState<string[]>(["employee:all"]);
  const [view, setView] = useState<View>({ kind: "home" });
  const [openSource, setOpenSource] = useState<OpenSource | null>(null);

  return (
    <div className="min-h-screen text-slate-900">
      <Header
        roles={roles}
        onRoleChange={(r) => setRoles(r)}
        onHome={() => {
          setView({ kind: "home" });
          setOpenSource(null);
        }}
        onConflicts={() => {
          setView({ kind: "conflicts" });
          setOpenSource(null);
        }}
      />

      <main className="mx-auto max-w-6xl px-6 py-8">
        {view.kind !== "conflicts" && (
          <div className="mb-8">
            <SearchBar
              initial={
                view.kind === "search" || view.kind === "entity"
                  ? view.query
                  : ""
              }
              onSearch={(q) => {
                setView({ kind: "search", query: q });
                setOpenSource(null);
              }}
            />
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className={openSource ? "lg:col-span-2" : "lg:col-span-3"}>
            {view.kind === "home" && (
              <HomeIntro
                onSearch={(q) => {
                  setView({ kind: "search", query: q });
                  setOpenSource(null);
                }}
              />
            )}
            {view.kind === "search" && (
              <SearchResults
                query={view.query}
                roles={roles}
                onEntityClick={(id) => setView({ kind: "entity", query: id })}
                onSourceClick={(id, highlight) =>
                  setOpenSource({ id, highlight })
                }
              />
            )}
            {view.kind === "entity" && (
              <EntityPage
                query={view.query}
                roles={roles}
                onSourceClick={(id, highlight) =>
                  setOpenSource({ id, highlight })
                }
              />
            )}
            {view.kind === "conflicts" && (
              <ConflictQueue
                roles={roles}
                resolverIdentity={pickResolverIdentity(roles)}
                onSourceClick={(id, highlight) =>
                  setOpenSource({ id, highlight })
                }
                onEntityClick={(id) =>
                  setView({ kind: "entity", query: id })
                }
              />
            )}
          </div>

          {openSource && (
            <aside className="lg:col-span-1">
              <SourceViewer
                source_id={openSource.id}
                roles={roles}
                highlightSpans={
                  openSource.highlight ? [openSource.highlight] : undefined
                }
                onClose={() => setOpenSource(null)}
              />
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * Map the active role profile to a stable identity string used as the
 * resolver author when a human resolves a conflict.
 */
function pickResolverIdentity(roles: string[]): string {
  if (roles.includes("role:exec")) return "exec-reviewer";
  if (roles.includes("role:hr")) return "hr-reviewer";
  if (roles.includes("role:customer_support")) return "cs-reviewer";
  if (roles.includes("role:engineering")) return "eng-reviewer";
  return "demo-reviewer";
}

