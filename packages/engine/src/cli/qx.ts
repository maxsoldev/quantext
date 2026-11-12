#!/usr/bin/env node
/** The `qx` entry: run the command with the process's arguments and I/O, and exit with its code. */
import { homedir, userInfo } from "node:os";
import { main } from "./main.ts";

// Node warns that node:sqlite is experimental on each run; that is not news to a user of qx.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  home: homedir(),
  user: userInfo().username,
});
