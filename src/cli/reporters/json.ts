import type { Diagnostic } from '../../core/types.js';

/**
 * Format diagnostics as a JSON structure.
 *
 * Output shape:
 * ```json
 * {
 *   "files": [
 *     {
 *       "uri": "file:///path/to/story.tw",
 *       "diagnostics": [
 *         {
 *           "range": { "start": { "line": 4, "character": 0 }, "end": { "line": 4, "character": 10 } },
 *           "message": "...",
 *           "severity": "error",
 *           "code": "SP101",
 *           "source": "spindle"
 *         }
 *       ]
 *     }
 *   ]
 * }
 * ```
 */
export function formatJson(
  results: Array<{ uri: string; diagnostics: Diagnostic[] }>,
): string {
  const output = {
    files: results.map(({ uri, diagnostics }) => ({
      uri,
      diagnostics: diagnostics.map(d => ({
        range: d.range,
        message: d.message,
        severity: d.severity,
        code: d.code,
        source: d.source,
      })),
    })),
  };

  return JSON.stringify(output, null, 2);
}
