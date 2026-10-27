import { splitLines } from '../core/text.js';
import type { Range } from '../core/types.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { builtinMacros, formatPassage, tokenizeMarkupTolerant } from '@rohal12/spindle/tooling';
import { isMarkupPassage, isRuntimePassage, parsePassageHeader } from '../core/parsing/passage-parser.js';
import { splitPassages, classifyPassage } from './format/segment.js';
import { loadPrettier } from './format/prettier-bridge.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Document path or file URI used to resolve its Prettier configuration. */
  filePath?: string;
  /** Returns true if the named macro is a block/container macro. */
  isBlock?: (name: string) => boolean;
  /** Returns true for sub-macros that dedent to parent level (else, elseif, next, case, default). */
  isDedentingSubMacro?: (name: string) => boolean;
  /** If set, wrap prose lines exceeding this character count. */
  maxLineLength?: number;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Default dedenting sub-macros. */
const DEFAULT_DEDENTING = new Set(['else', 'elseif', 'next', 'case', 'default']);

// ---------------------------------------------------------------------------
// Default block detection from the built-in macros + document scan
// ---------------------------------------------------------------------------

/** The built-in block macros, lowercased. */
const BUILTIN_CONTAINERS = new Set(builtinMacros.filter(m => m.block).map(m => m.name.toLowerCase()));

/** The names of the macros the document closes with `{/name}`: block macros it defines itself. */
function detectContainersFromText(text: string): Set<string> {
  const found = new Set<string>();
  for (const t of tokenizeMarkupTolerant(text).tokens) {
    if (t.type === 'macro' && t.isClose) found.add(t.name.toLowerCase());
  }
  return found;
}

/** Build an isBlock function from the built-in block macros + document auto-detection. */
function buildDefaultIsBlock(text: string): (name: string) => boolean {
  const containers = new Set([...BUILTIN_CONTAINERS, ...detectContainersFromText(text)]);
  return (name: string) => containers.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Core format functions
// ---------------------------------------------------------------------------

/**
 * Format an entire document: each passage body with Spindle's
 * `formatPassage` (block macro indentation, trailing whitespace, Prettier for
 * script and stylesheet passages, `<script>` and HTML blocks), and the Twee
 * layer around them here.
 *
 * Rules of this layer:
 *  1. Normalize passage headers: `::  Name  [tag]` -> `:: Name [tag]`
 *  2. Keep one blank line between passages that were separated by blank lines
 *  3. Ensure file ends with a single newline, in the document's line-ending style
 */
export async function formatDocument(text: string, options?: FormatOptions): Promise<string> {
  // A byte order mark is not story text: format what follows it and keep the mark
  if (text.charCodeAt(0) === 0xfeff) return '﻿' + await formatDocument(text.slice(1), options);
  // Format with LF endings, then give the output the document's own style
  const eol = dominantEol(text);
  const output = await formatLf(splitLines(text).join('\n'), options);
  return output.replace(/\n/g, eol);
}

/**
 * The most common document line ending (LF, CRLF or CR), preferring the
 * first encountered on a tie. The compiler normalizes each form to LF.
 */
function dominantEol(text: string): string {
  const counts = new Map<string, number>();
  for (const [ending] of text.matchAll(/\r\n|[\r\n]/g)) {
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n';
}

async function formatLf(text: string, options?: FormatOptions): Promise<string> {
  const isBlock = options?.isBlock ?? buildDefaultIsBlock(text);
  const isDedentingSubMacro = options?.isDedentingSubMacro
    ?? ((name: string) => DEFAULT_DEDENTING.has(name.toLowerCase()));
  const prettier = await loadPrettier(options?.filePath);

  const passages = splitPassages(text);
  const resultLines: string[] = [];

  for (let pi = 0; pi < passages.length; pi++) {
    const passage = passages[pi];

    // Preserve blank line separator between passages when the original had one
    if (pi > 0 && passage.header) {
      const prev = passages[pi - 1];
      const prevBodyLineCount = prev.body ? prev.body.split('\n').length - 1 : 0;
      const prevEndLine = prev.startLine + (prev.header ? 1 : 0) + prevBodyLineCount;
      if (passage.startLine > prevEndLine) {
        // There were blank lines between passages — emit one blank separator
        resultLines.push('');
      }
    }

    // Normalize and emit passage header
    if (passage.header) {
      resultLines.push(normalizePassageHeader(passage.header));
    }

    if (passage.body === '') continue;
    const role = parsePassageHeader(passage.header, passage.startLine);
    const kind = classifyPassage(passage.header);
    // Compiler metadata keeps its name-based role even with code tags.
    const body = role && (!isRuntimePassage({ name: role.name }) || (kind === 'normal' && !isMarkupPassage(role)))
      ? passage.body
      : await formatPassage(passage.body, {
      kind,
      prettier: prettier?.prettier,
      prettierOptions: prettier?.options,
      isBlock,
      isDedentingSubMacro,
      maxLineLength: options?.maxLineLength,
    });
    resultLines.push(body.replace(/\n$/, ''));
  }

  return resultLines.join('\n').replace(/\n*$/, '\n');
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
  const header = parsePassageHeader(line, 0);
  if (!header) return line;
  const { start, end } = header.nameRange;
  const name = line.slice(start.character, end.character);
  const suffix = line.slice(end.character).trim();
  return `:: ${name}${suffix ? ` ${suffix}` : ''}`;
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
      // Block widgets (whose body renders {@children}) are containers too
      isBlock: (name) => ctx.workspace.isContainer(name),
      isDedentingSubMacro: (name) => DEFAULT_DEDENTING.has(name.toLowerCase()),
    };

    ctx.connection.onDocumentFormatting(async (params) => {
      const text = ctx.workspace.documents.getText(params.textDocument.uri);
      if (text === undefined) return [];

      const formatted = await formatDocument(text, { ...formatOpts, filePath: params.textDocument.uri });
      if (formatted === text) return [];

      const lines = splitLines(text);
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

      const formatted = await formatRange(text, range, { ...formatOpts, filePath: params.textDocument.uri });
      if (formatted === text) return [];

      const lines = splitLines(text);
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
