/** Catches an error while a page renders: says what failed and offers a way on, instead of a blank page. */
import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { Link } from "../nav.tsx";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("The page failed to render:", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="empty" role="alert" data-testid="page-error">
        <h1>This page failed to show</h1>
        <p className="error">{error.message}</p>
        <p>
          The viewer hit a bug while drawing this page. Its data in the engine is not changed.{" "}
          <Link to={{ page: "sessions" }}>Open the session list</Link>, or reload the page.
        </p>
      </section>
    );
  }
}
