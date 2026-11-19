import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';

/** Check discovery candidates without excluding directories during traversal. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Read only a regular file, even if its path changed after discovery.
 * Nonblocking open avoids waiting for a FIFO writer before we can inspect
 * the descriptor; fstat and read then refer to the same opened file.
 * Explicit file symlinks retain the caller's opt-in behavior.
 */
export function readRegularFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Expected a regular file: ${path}`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
