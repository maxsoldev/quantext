/** query: the one read API over the store, and the SQL views for agents. Depends on core, store. */
export { CATEGORIES, categoryOf } from "./categories.ts";
export type { Query, QueryOptions } from "./query.ts";
export { createQuery } from "./query.ts";
export type { Redactor } from "./redact.ts";
export { createRedactor, projectAllowed } from "./redact.ts";
export { checkReadOnly, DEFAULT_SQL_LIMIT, runSql, SqlRejectedError } from "./sql.ts";
export { installViews, VIEWS } from "./views.ts";
