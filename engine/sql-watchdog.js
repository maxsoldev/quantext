import { workerData } from "node:worker_threads";
// packages/engine/src/cli/sql-watchdog.ts
/**
* The SQL child's watchdog, in a worker thread: a long statement blocks the child's main thread, not this one. It
* kills the whole process at the deadline, or as soon as the parent `qx` is gone (killed, so it could not).
*/
const { parent, deadline } = workerData;
const parentGone = () => {
	if (process.ppid !== parent) return true;
	try {
		process.kill(parent, 0);
		return false;
	} catch {
		return true;
	}
};
setInterval(() => {
	if (Date.now() >= deadline || parentGone()) process.kill(process.pid, "SIGKILL");
}, 100);
export {};
