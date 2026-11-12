#!/usr/bin/env node
/** The `qx` entry: run the command with the process's arguments and I/O, and exit with its code. */
import "./quiet.ts";
import { homedir, userInfo } from "node:os";
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  home: homedir(),
  user: userInfo().username,
});
