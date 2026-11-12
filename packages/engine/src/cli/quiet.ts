/** Node warns that node:sqlite is experimental on each run; that is not news to a user of qx. Other warnings print. */
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});
