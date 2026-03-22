import { fileURLToPath } from 'node:url';
import type { Diagnostic } from '../../core/types.js';

/**
 * ANSI color codes for terminal output.
 */
const colors = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

const severityColors: Record<string, string> = {
  error: colors.red,
  warning: colors.yellow,
  info: colors.blue,
  hint: colors.cyan,
};

/**
 * Format diagnostics in a human-readable, colored terminal format.
 *
 * Example:
 *   src/story.tw:5:1 error SP101 Malformed container: no matching {/if}
 *   src/story.tw:7:1 warning SP100 Unrecognized macro: unknownMacro
 *
 *   Found 2 problems (1 error, 1 warning)
 */
export function formatPretty(
  results: Array<{ uri: string; diagnostics: Diagnostic[] }>,
): string {
  if (results.length === 0) {
    return `${colors.bold}No problems found${colors.reset}`;
  }

  const lines: string[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  let hintCount = 0;

  for (const { uri, diagnostics } of results) {
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      filePath = uri;
    }

    for (const diag of diagnostics) {
      const line = diag.range.start.line + 1;
      const col = diag.range.start.character + 1;
      const color = severityColors[diag.severity] ?? colors.gray;

      lines.push(
        `${colors.bold}${filePath}:${line}:${col}${colors.reset} ` +
        `${color}${diag.severity}${colors.reset} ` +
        `${colors.gray}${diag.code}${colors.reset} ` +
        `${diag.message}`,
      );

      switch (diag.severity) {
        case 'error': errorCount++; break;
        case 'warning': warningCount++; break;
        case 'info': infoCount++; break;
        case 'hint': hintCount++; break;
      }
    }
  }

  const total = errorCount + warningCount + infoCount + hintCount;
  const parts: string[] = [];
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);
  if (warningCount > 0) parts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`);
  if (infoCount > 0) parts.push(`${infoCount} info`);
  if (hintCount > 0) parts.push(`${hintCount} hint${hintCount !== 1 ? 's' : ''}`);

  lines.push('');
  lines.push(
    `${colors.bold}Found ${total} problem${total !== 1 ? 's' : ''} (${parts.join(', ')})${colors.reset}`,
  );

  return lines.join('\n');
}
