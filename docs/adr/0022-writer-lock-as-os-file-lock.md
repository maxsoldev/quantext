# 22. The writer lock is an OS file lock

Status: accepted

## Context

The first writer lock was a file with a pid; a lock whose pid did not run was stale. A reused pid (after a
reboot, or in a container) made a stale lock look held, so the engine could never start again.

## Decision

The lock is `writer.lock` in the data folder: a small SQLite database that the engine holds in an exclusive
transaction (`locking_mode = EXCLUSIVE`, `BEGIN EXCLUSIVE`, busy timeout 0) for as long as the store is open.
This is a file lock of the OS, which the OS releases when the process ends, also when it is killed. A second
engine gets `SQLITE_BUSY` and a `StoreLockedError`. `writer.pid` only names the holder in that error. Both
`node:sqlite` and `bun:sqlite` support it, and tests check contention and release after `SIGKILL` on both.

## Consequences

- No stale locks and no pid checks. ADR 4's "lock file in `~/.quantext/`" is this lock.
- A lock file of the first engine (JSON, not a database) is replaced.
