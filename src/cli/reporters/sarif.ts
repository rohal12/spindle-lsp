import type { Diagnostic } from '../../core/types.js';

/**
 * SARIF 2.1.0 severity mapping.
 */
const sarifLevelMap: Record<string, string> = {
  error: 'error',
  warning: 'warning',
  info: 'note',
  hint: 'note',
};

/**
 * Format diagnostics in SARIF 2.1.0 format.
 *
 * @see https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */
export function formatSarif(
  results: Array<{ uri: string; diagnostics: Diagnostic[] }>,
): string {
  // Collect unique rule IDs
  const ruleIds = new Set<string>();
  for (const { diagnostics } of results) {
    for (const d of diagnostics) {
      ruleIds.add(d.code);
    }
  }

  // Build SARIF results
  const sarifResults = [];
  for (const { uri, diagnostics } of results) {
    for (const d of diagnostics) {
      sarifResults.push({
        ruleId: d.code,
        level: sarifLevelMap[d.severity] ?? 'note',
        message: { text: d.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              region: {
                startLine: d.range.start.line + 1,
                startColumn: d.range.start.character + 1,
                endLine: d.range.end.line + 1,
                endColumn: d.range.end.character + 1,
              },
            },
          },
        ],
      });
    }
  }

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0' as const,
    runs: [
      {
        tool: {
          driver: {
            name: 'spindle-lsp',
            version: '0.1.0',
            rules: Array.from(ruleIds).map(id => ({
              id,
              shortDescription: { text: `Spindle diagnostic ${id}` },
            })),
          },
        },
        results: sarifResults,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
