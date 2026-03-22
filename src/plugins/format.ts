import type { Range } from '../core/types.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';

// ---------------------------------------------------------------------------
// Block macro patterns for indentation
// ---------------------------------------------------------------------------

/**
 * Matches opening block macros: {if ...}, {for ...}, {switch ...}, {unless ...}
 * Also handles custom block macros via generic pattern.
 */
const BLOCK_OPEN_REGEX = /^\s*\{(if|for|switch|unless|widget)\b/i;

/**
 * Matches closing block macros: {/if}, {/for}, {/switch}, {/unless}
 */
const BLOCK_CLOSE_REGEX = /^\s*\{\/(if|for|switch|unless|widget)\b/i;

/**
 * Passage header pattern.
 */
const PASSAGE_HEADER_REGEX = /^(::)\s+/;

// ---------------------------------------------------------------------------
// Core format functions (no LSP dependency)
// ---------------------------------------------------------------------------

/**
 * Format an entire document.
 *
 * Rules:
 *  1. Indent content inside block macros by 2 spaces per nesting level
 *  2. Remove trailing whitespace from each line
 *  3. Ensure file ends with a single newline
 *  4. Normalize passage headers: `::  Name  [tag]` -> `:: Name [tag]`
 */
export function formatDocument(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let indentLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Remove trailing whitespace
    line = line.replace(/\s+$/, '');

    // Normalize passage headers
    if (PASSAGE_HEADER_REGEX.test(line)) {
      line = normalizePassageHeader(line);
      // Reset indent at passage boundaries
      indentLevel = 0;
      result.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Empty lines: keep them but without extra whitespace
    if (trimmed === '') {
      result.push('');
      continue;
    }

    // Check if this line closes a block (reduce indent before writing)
    if (BLOCK_CLOSE_REGEX.test(trimmed)) {
      indentLevel = Math.max(0, indentLevel - 1);
    }

    // Apply indentation
    const indented = indentLevel > 0
      ? '  '.repeat(indentLevel) + trimmed
      : trimmed;
    result.push(indented);

    // Check if this line opens a block (increase indent for subsequent lines)
    if (BLOCK_OPEN_REGEX.test(trimmed)) {
      indentLevel++;
    }
  }

  // Ensure file ends with a single newline
  let output = result.join('\n');
  output = output.replace(/\n*$/, '\n');

  return output;
}

/**
 * Format a specific range within a document.
 * Extracts the range, formats it, and replaces back.
 */
export function formatRange(text: string, range: Range): string {
  const lines = text.split('\n');
  const startLine = Math.max(0, range.start.line);
  const endLine = Math.min(lines.length - 1, range.end.line);

  // Extract the range
  const rangeLines = lines.slice(startLine, endLine + 1);
  const rangeText = rangeLines.join('\n');

  // Format just that section
  const formatted = formatDocument(rangeText);
  const formattedLines = formatted.replace(/\n$/, '').split('\n');

  // Reconstruct the full document
  const before = lines.slice(0, startLine);
  const after = lines.slice(endLine + 1);
  const result = [...before, ...formattedLines, ...after].join('\n');

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a passage header line.
 * Collapses whitespace: `::  Name  [tag]` -> `:: Name [tag]`
 */
function normalizePassageHeader(line: string): string {
  // Split into parts: "::", name, optional tags/metadata
  const headerMatch = line.match(/^::\s+(.*)/);
  if (!headerMatch) return line;

  const rest = headerMatch[1];

  // Check for tags in brackets
  const bracketIdx = rest.indexOf('[');
  const braceIdx = rest.indexOf('{');

  let name: string;
  let suffix = '';

  if (bracketIdx !== -1 && (braceIdx === -1 || bracketIdx < braceIdx)) {
    name = rest.substring(0, bracketIdx).trim();
    suffix = ' ' + rest.substring(bracketIdx).trim();
  } else if (braceIdx !== -1) {
    name = rest.substring(0, braceIdx).trim();
    suffix = ' ' + rest.substring(braceIdx).trim();
  } else {
    name = rest.trim();
  }

  return `:: ${name}${suffix}`;
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

export const formatPlugin: SpindlePlugin = {
  id: 'format',
  capabilities: {
    documentFormattingProvider: true,
    documentRangeFormattingProvider: true,
  },
  initialize(ctx: PluginContext) {
    ctx.connection.onDocumentFormatting((params) => {
      const text = ctx.workspace.documents.getText(params.textDocument.uri);
      if (text === undefined) return [];

      const formatted = formatDocument(text);
      if (formatted === text) return [];

      const lines = text.split('\n');
      return [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines[lines.length - 1].length },
        },
        newText: formatted,
      }];
    });

    ctx.connection.onDocumentRangeFormatting((params) => {
      const text = ctx.workspace.documents.getText(params.textDocument.uri);
      if (text === undefined) return [];

      const range: Range = {
        start: { line: params.range.start.line, character: params.range.start.character },
        end: { line: params.range.end.line, character: params.range.end.character },
      };

      const formatted = formatRange(text, range);
      if (formatted === text) return [];

      const lines = text.split('\n');
      return [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: lines[lines.length - 1].length },
        },
        newText: formatted,
      }];
    });
  },
};
