/** Open a URL in the browser: the platform's opener with the URL as its one argument, never through a shell. */
import { execFile } from "node:child_process";

/** The opener and its arguments. Windows: `start` is a shell built-in, so `rundll32` opens the URL instead. */
export function openerFor(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** Open `url`; a failure is passed to `onError` (the engine goes on). */
export function openUrl(url: string, onError: (error: Error) => void): void {
  const [command, args] = openerFor(process.platform, url);
  const child = execFile(command, args, { shell: false, windowsHide: true }, (error) => {
    if (error !== null) onError(error);
  });
  child.unref();
}
