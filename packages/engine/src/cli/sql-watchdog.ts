/**
 * The SQL child's watchdog, in a worker thread: a long statement blocks the child's main thread, not this one. It
 * kills the whole process at the deadline, or as soon as the parent `qx` is gone (killed, so it could not).
 */
import { workerData } from "node:worker_threads";

const { parent, deadline } = workerData as { parent: number; deadline: number };

const parentGone = (): boolean => {
  if (process.ppid !== parent) return true; // re-parented: the parent died
  try {
    process.kill(parent, 0);
    return false;
  } catch {
    return true; // ESRCH: no such process
  }
};

setInterval(() => {
  if (Date.now() >= deadline || parentGone()) process.kill(process.pid, "SIGKILL");
}, 100);
