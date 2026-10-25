import { pathToFileURL } from 'node:url';

/** Folder compilation walks entries by UTF-8 name, descending before the next sibling. */
export function compareSourceUris(left: string, right: string): number {
  const a = left.split('/').map(decodeURIComponent);
  const b = right.split('/').map(decodeURIComponent);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = Buffer.compare(Buffer.from(a[i], 'utf8'), Buffer.from(b[i], 'utf8'));
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** Compare native file paths without treating percent signs as URI escapes. */
export function compareSourcePaths(left: string, right: string): number {
  return compareSourceUris(pathToFileURL(left).href, pathToFileURL(right).href);
}
