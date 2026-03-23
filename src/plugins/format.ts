import type { Range } from '../core/types.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import supplements from '../macro-supplements.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Returns true if the named macro is a block/container macro. */
  isBlock?: (name: string) => boolean;
  /** Returns true for sub-macros that dedent to parent level (else, elseif, next, case, default). */
  isDedentingSubMacro?: (name: string) => boolean;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const PASSAGE_HEADER_REGEX = /^(::)\s+/;

/** Matches an opening macro tag, capturing optional CSS prefix and macro name. */
const MACRO_OPEN_REGEX = /^\{(?:[#.][a-zA-Z][\w-]*\s*)*([A-Za-z][\w-]*)\b/;

/** Matches a closing macro tag, capturing the macro name. */
const MACRO_CLOSE_REGEX = /^\{\/([A-Za-z][\w-]*)\b/;

/** Default dedenting sub-macros. */
const DEFAULT_DEDENTING = new Set(['else', 'elseif', 'next', 'case', 'default']);

// ---------------------------------------------------------------------------
// Default block detection from supplements + document scan
// ---------------------------------------------------------------------------

/** Container macro names from macro-supplements.json. */
function getSupplementContainers(): Set<string> {
  const containers = new Set<string>();
  for (const [key, entry] of Object.entries(supplements)) {
    if ((entry as { container?: boolean }).container) {
      containers.add(key.toLowerCase());
    }
  }
  return containers;
}

/** Scan a document for {/Name} closing tags and collect macro names. */
function detectContainersFromText(text: string): Set<string> {
  const found = new Set<string>();
  const re = /\{\/([A-Za-z][\w-]*)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1].toLowerCase());
  }
  return found;
}

/** Build an isBlock function from supplements + document auto-detection. */
function buildDefaultIsBlock(text: string): (name: string) => boolean {
  const containers = getSupplementContainers();
  for (const name of detectContainersFromText(text)) {
    containers.add(name);
  }
  return (name: string) => containers.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Core format functions
// ---------------------------------------------------------------------------

/**
 * Format an entire document.
 *
 * Rules:
 *  1. Indent content inside block macros by 2 spaces per nesting level
 *  2. Dedenting sub-macros (else, elseif, next, case, default) snap to parent indent level
 *  3. Remove trailing whitespace from each line
 *  4. Ensure file ends with a single newline
 *  5. Normalize passage headers: `::  Name  [tag]` -> `:: Name [tag]`
 */
export async function formatDocument(text: string, options?: FormatOptions): Promise<string> {
  const isBlock = options?.isBlock ?? buildDefaultIsBlock(text);
  const isDedenting = options?.isDedentingSubMacro
    ?? ((name: string) => DEFAULT_DEDENTING.has(name.toLowerCase()));

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
      indentLevel = 0;
      result.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Empty lines: preserve without whitespace
    if (trimmed === '') {
      result.push('');
      continue;
    }

    // Check for dedenting sub-macro (else, elseif, next, case, default)
    const dedentMatch = trimmed.match(MACRO_OPEN_REGEX);
    if (dedentMatch && isDedenting(dedentMatch[1])) {
      indentLevel = Math.max(0, indentLevel - 1);
      result.push(indentLevel > 0 ? '  '.repeat(indentLevel) + trimmed : trimmed);
      indentLevel++;
      continue;
    }

    // Check for closing tag
    const closeMatch = trimmed.match(MACRO_CLOSE_REGEX);
    if (closeMatch) {
      indentLevel = Math.max(0, indentLevel - 1);
    }

    // Apply indentation
    result.push(indentLevel > 0 ? '  '.repeat(indentLevel) + trimmed : trimmed);

    // Check for opening container tag
    const openMatch = trimmed.match(MACRO_OPEN_REGEX);
    if (openMatch && isBlock(openMatch[1])) {
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
 * Formats the full document — Prettier can change line counts, making
 * line-index slicing unreliable. The LSP plugin already replaces the
 * entire document content, so this is safe and correct.
 */
export async function formatRange(text: string, _range: Range, options?: FormatOptions): Promise<string> {
  return formatDocument(text, options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePassageHeader(line: string): string {
  const headerMatch = line.match(/^::\s+(.*)/);
  if (!headerMatch) return line;

  const rest = headerMatch[1];
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
    const formatOpts: FormatOptions = {
      isBlock: (name) => ctx.workspace.macros.isBlock(name),
      isDedentingSubMacro: (name) => DEFAULT_DEDENTING.has(name.toLowerCase()),
    };

    ctx.connection.onDocumentFormatting(async (params) => {
      const text = ctx.workspace.documents.getText(params.textDocument.uri);
      if (text === undefined) return [];

      const formatted = await formatDocument(text, formatOpts);
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

    ctx.connection.onDocumentRangeFormatting(async (params) => {
      const text = ctx.workspace.documents.getText(params.textDocument.uri);
      if (text === undefined) return [];

      const range: Range = {
        start: { line: params.range.start.line, character: params.range.start.character },
        end: { line: params.range.end.line, character: params.range.end.character },
      };

      const formatted = await formatRange(text, range, formatOpts);
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
