import { DatabaseSync } from "node:sqlite";
// packages/engine/src/store/node-driver.ts
/** The `node:sqlite` adapter of the SQL driver. */
/** SQLite's authorizer codes for reading (sqlite3.h): READ, SELECT, FUNCTION, RECURSIVE. */
const READ_ACTIONS = /* @__PURE__ */ new Set([
	20,
	21,
	31,
	33
]);
const SQLITE_PRAGMA = 19;
/** Pragmas that only describe the schema, so an agent can discover it (`pragma_table_info('calls')`). */
const SCHEMA_PRAGMAS = /* @__PURE__ */ new Set([
	"table_info",
	"table_xinfo",
	"table_list",
	"index_list",
	"index_info",
	"index_xinfo",
	"foreign_key_list"
]);
const SQLITE_OK = 0;
const SQLITE_DENY = 1;
function hasAuthorizer() {
	return typeof DatabaseSync.prototype.setAuthorizer === "function";
}
function openNode(path, options = {}) {
	const db = new DatabaseSync(path, options.readOnly === true ? { readOnly: true } : {});
	return {
		runtime: "node",
		exec: (sql) => db.exec(sql),
		prepare(sql) {
			const statement = db.prepare(sql);
			return {
				run: (...params) => ({ changes: Number(statement.run(...params).changes) }),
				get: (...params) => statement.get(...params),
				all: (...params) => statement.all(...params),
				iterate: (...params) => statement.iterate(...params),
				columns: () => statement.columns().map((c) => c.name)
			};
		},
		inTransaction: () => db.isTransaction,
		denyAllButReads() {
			const set = db.setAuthorizer;
			if (typeof set !== "function") return false;
			set.call(db, (action, name) => READ_ACTIONS.has(action) || action === SQLITE_PRAGMA && SCHEMA_PRAGMAS.has(String(name).toLowerCase()) ? SQLITE_OK : SQLITE_DENY);
			return true;
		},
		close: () => db.close()
	};
}
export { hasAuthorizer, openNode };
