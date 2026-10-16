/**
 * A story value as plain JSON data. `spindle/play` returns variables as
 * structured clones, which JSON.stringify would render wrongly (a Map as `{}`,
 * a Set as `{}`) or not at all (a cycle throws). Maps become objects of their
 * entries, Sets and typed arrays arrays, Dates ISO strings, and a cycle the
 * string `"[circular]"`. As in JSON, an undefined property is left out and an
 * undefined array item becomes null.
 *
 * Map keys become strings (an object key its JSON), so keys that stringify
 * alike collide: `1` and `"1"` end up as one property, holding the later
 * entry's value.
 */
export function toJsonSafe(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint' || typeof value === 'symbol') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof RegExp) return String(value);
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    const convert = (item: unknown) => toJsonSafe(item, ancestors);
    if (Array.isArray(value) || value instanceof Set) return Array.from(value, convert);
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return Array.from(value as unknown as ArrayLike<unknown>, convert);
    }
    if (value instanceof Map) {
      const entries = [...value].map(([key, item]) => [mapKey(key, ancestors), convert(item)]);
      return Object.fromEntries(entries);
    }
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    const fields = Object.entries(value).filter(([, item]) => item !== undefined);
    return Object.fromEntries(fields.map(([key, item]) => [key, convert(item)]));
  } finally {
    ancestors.delete(value);
  }
}

function mapKey(key: unknown, ancestors: Set<object>): string {
  if (typeof key === 'string') return key;
  if (typeof key === 'object' && key !== null) return JSON.stringify(toJsonSafe(key, ancestors));
  return String(key);
}
