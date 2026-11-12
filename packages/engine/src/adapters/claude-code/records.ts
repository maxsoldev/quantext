/**
 * Read and write the state's records by keys that come from the log. A key such as `__proto__` must stay a plain
 * key: plain assignment would change the object's prototype instead.
 */
export function get<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function put<T>(record: Record<string, T>, key: string, value: T): T {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

export function drop<T>(record: Record<string, T>, key: string): void {
  if (Object.hasOwn(record, key)) delete record[key];
}
