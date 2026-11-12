import { Database } from "bun:sqlite";
// packages/engine/src/store/bun-driver.ts
/** The `bun:sqlite` adapter of the SQL driver. */
function openBun(path, options = {}) {
	const db = new Database(path, options.readOnly === true ? { readonly: true } : { create: true });
	return {
		runtime: "bun",
		exec: (sql) => db.exec(sql),
		prepare(sql) {
			const statement = db.prepare(sql);
			return {
				run: (...params) => ({ changes: statement.run(...params).changes }),
				get: (...params) => statement.get(...params) ?? void 0,
				all: (...params) => statement.all(...params),
				iterate: (...params) => statement.iterate(...params),
				columns: () => [...statement.columnNames]
			};
		},
		inTransaction: () => db.inTransaction,
		denyAllButReads: () => false,
		close: () => db.close()
	};
}
export { openBun };
