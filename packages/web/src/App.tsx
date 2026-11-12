import { Link, useRoute } from "./nav.tsx";
import { SessionList } from "./pages/SessionList.tsx";

export function App() {
  const route = useRoute();
  return (
    <div className="app">
      <header className="masthead">
        <Link to={{ page: "sessions" }} className="brand">
          Quantext
        </Link>
      </header>
      <main className="page">
        {route.page === "sessions" && <SessionList route={route} />}
        {route.page === "session" && <p>Session {route.key.id}</p>}
        {route.page === "not-found" && <p>No page here.</p>}
      </main>
    </div>
  );
}
