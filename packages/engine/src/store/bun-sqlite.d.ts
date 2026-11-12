/**
 * The part of Bun's `bun:sqlite` that the Bun driver uses. Declared here instead of adding `@types/bun`: the engine
 * type checks against Node's types, and this is the only Bun module it loads.
 */
declare module "bun:sqlite" {
  type Value = string | number | bigint | boolean | null | Uint8Array;
  export class Statement {
    run(...params: Value[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: Value[]): unknown;
    all(...params: Value[]): unknown[];
    iterate(...params: Value[]): IterableIterator<unknown>;
    readonly columnNames: string[];
  }
  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean; strict?: boolean });
    readonly inTransaction: boolean;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
