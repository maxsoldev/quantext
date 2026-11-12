import { api } from "../api/client.ts";
import { tokens, usd } from "../format/format.ts";
import { useLiveVersion } from "../live/hooks.ts";
import { Link } from "../nav.tsx";
import type { Route } from "../route.ts";
import { useLoad } from "../ui/useLoad.ts";

export function SessionList({ route }: { route: Extract<Route, { page: "sessions" }> }) {
  const version = useLiveVersion(() => true);
  const page = useLoad((signal) => api.sessions({ limit: 200 }, signal), [version]);
  if (page.state === "error") return <p role="alert">{page.error.message}</p>;
  if (page.value === undefined) return <p>Loading sessions…</p>;
  return (
    <section aria-label="Sessions">
      <h1>Sessions</h1>
      <table className="sessions">
        <tbody>
          {page.value.items.map((s) => (
            <tr key={`${s.log}/${s.id}`} data-testid="session-row">
              <td>
                <Link to={{ page: "session", key: s }}>{s.title ?? s.id}</Link>
              </td>
              <td>{s.project}</td>
              <td data-testid="calls">{s.calls}</td>
              <td>{usd(s.cost.totalUsd)}</td>
              <td>{tokens(s.maxContextTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {route.project}
    </section>
  );
}
