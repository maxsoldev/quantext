/** Client-side navigation over the History API: one source of truth for the Route, and links that use it. */
import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { useSyncExternalStore } from "react";
import type { Route } from "./route.ts";
import { hrefOf, parseRoute } from "./route.ts";

const listeners = new Set<() => void>();
let current = read();

function read(): Route {
  return parseRoute(location.pathname, location.search);
}

function changed(): void {
  current = read();
  for (const fn of listeners) fn();
}

addEventListener("popstate", changed);

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const href = hrefOf(route);
  if (href === location.pathname + location.search) return;
  if (options.replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  changed();
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: Route };

/** An `<a>` to a Route: a plain click navigates in place; a modified click opens a tab as usual. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={hrefOf(to)} onClick={go} {...rest} />;
}
