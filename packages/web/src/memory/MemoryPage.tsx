/**
 * A project's memory files (`MEMORY.md`, the index, and the files it points to), with when each last changed. It
 * reads again on each `memory` event for the project, so a file the harness writes shows up while you watch.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import { ago, count, projectName, when } from "../format/format.ts";
import { useLiveVersion } from "../live/hooks.ts";
import { Link, navigate } from "../nav.tsx";
import type { Route } from "../route.ts";
import { useLoad } from "../ui/useLoad.ts";
import { INDEX, indexEntries, memoryFiles } from "./model.ts";

type MemoryRoute = Extract<Route, { page: "memory" }>;

export function MemoryPage({ route }: { route: MemoryRoute }) {
  const project = route.project;
  const version = useLiveVersion((e) => e.kind === "memory" && e.projects.includes(project));
  const data = useLoad((signal) => api.memory(project, signal), [project, version]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const files = data.value ? memoryFiles(data.value.items) : [];
  const open = files.find((f) => f.path === route.file) ?? files[0];
  const pick = (file: string) => navigate({ ...route, file }, { replace: true });
  return (
    <article className="memory-page" aria-labelledby="memory-title" data-testid="memory">
      <header className="session-head">
        <div className="session-name">
          <h1 id="memory-title">Memory of {projectName(project)}</h1>
          <p className="muted">
            <Link to={{ page: "sessions", project }}>Sessions of this project</Link>
          </p>
        </div>
      </header>
      <p className="memory-lede">
        Notes the harness keeps for this project across sessions. It adds the index, <code>{INDEX}</code>, to the
        context of each new session, so every line of it costs tokens in every call. The model reads the other files
        only when it needs one.
      </p>
      {data.state === "error" && !data.value && (
        <p className="error" role="alert">
          The memory could not be read: {data.error.message}
        </p>
      )}
      {!data.value && data.state === "loading" && <p className="muted">Reading the memory…</p>}
      {data.value && files.length === 0 && (
        <section className="card empty">
          <h2>No memory files in this project</h2>
          <p>
            The harness writes them to the project's <code>memory</code> folder when it decides to remember something,
            or when you ask it to. This page updates when it does.
          </p>
        </section>
      )}
      {open && (
        <div className="memory-body">
          <nav className="memory-files card" aria-label="Memory files">
            <h2>{count(files.length, "file")}</h2>
            <ul>
              {files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    className="memory-file"
                    aria-current={f.path === open.path ? "true" : undefined}
                    onClick={() => pick(f.path)}
                    data-testid="memory-file"
                  >
                    <span className="memory-name">{f.path}</span>
                    <span className="sub">
                      <span data-tip={when(new Date(f.mtimeMs).toISOString())}>
                        changed {ago(new Date(f.mtimeMs).toISOString(), now)}
                      </span>
                      <span className="num">{f.size.toLocaleString("en-US")} bytes</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <section className="card memory-doc" aria-labelledby="memory-doc-title">
            <div className="diff-head">
              <h2 id="memory-doc-title">{open.path}</h2>
              <p className="muted">
                Changed {when(new Date(open.mtimeMs).toISOString())}, {open.size.toLocaleString("en-US")} bytes
              </p>
            </div>
            {open.path === INDEX && (
              <IndexLinks content={open.content} files={files.map((f) => f.path)} onPick={pick} />
            )}
            <pre className="content block-text" data-testid="memory-content">
              {open.content}
            </pre>
          </section>
        </div>
      )}
    </article>
  );
}

function IndexLinks({ content, files, onPick }: { content: string; files: string[]; onPick: (file: string) => void }) {
  const entries = indexEntries(content);
  if (entries.length === 0) return null;
  return (
    <ul className="index-entries">
      {entries.map((e) => (
        <li key={e.file}>
          {files.includes(e.file) ? (
            <button type="button" className="link" onClick={() => onPick(e.file)}>
              {e.title}
            </button>
          ) : (
            <span>
              {e.title} <span className="tag">No such file</span>
            </span>
          )}
          {e.hook && <span className="muted"> {e.hook}</span>}
        </li>
      ))}
    </ul>
  );
}
