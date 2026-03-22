import type { DeclaredVariable, MacroNode, Range } from '../types.js';
import { parsePassageHeader } from '../parsing/passage-parser.js';

/** Regex to match $variable references including dot notation. */
const varRefRegex = /\$([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;

/** Passages excluded from variable scanning. */
const EXCLUDED_PASSAGES = new Set([
  'StoryVariables', 'StoryInit', 'StoryData', 'StoryScript', 'StoryInterface',
]);

/** Patterns that should be stripped before scanning for variable references. */
const CLEAN_PATTERNS = [
  /<!--[\s\S]*?-->/g,                           // HTML comments
  /<script(?:\s+[^>]*)?>[\s\S]*?<\/script>/gi,  // script tags
  /<style>[\s\S]*?<\/style>/gi,                  // style tags
  /`(?:\\.|[^`\\])*`/g,                          // backtick strings
  /"(?:\\.|[^"\\])*"/g,                          // double-quoted strings
  /'(?:\\.|[^'\\])*'/g,                          // single-quoted strings
];

interface VariableUsage {
  uri: string;
  baseName: string;
  fullName: string;
  range: Range;
}

/**
 * Tracks declared variables (from StoryVariables) and variable usages across documents.
 */
export class VariableTracker {
  private declared = new Map<string, DeclaredVariable>();
  private _hasStoryVariables = false;

  /** Per-URI list of variable usages. */
  private usagesByUri = new Map<string, VariableUsage[]>();

  /**
   * Parse the StoryVariables passage content for declarations.
   * Each line like `$name = value` becomes a declaration.
   */
  parseStoryVariables(content: string): void {
    this.declared.clear();
    this._hasStoryVariables = true;

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('<!--')) continue;

      const match = /^\$([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;

      const name = match[1];
      const expr = match[2].trim();
      const decl: DeclaredVariable = { name, sigil: '$' };

      // Extract top-level object fields for dot-notation validation
      if (expr.startsWith('{')) {
        const fieldRegex = /(\w+)\s*:/g;
        let fieldMatch;
        const fields: string[] = [];
        while ((fieldMatch = fieldRegex.exec(expr)) !== null) {
          fields.push(fieldMatch[1]);
        }
        if (fields.length > 0) {
          decl.fields = fields;
        }
      }

      this.declared.set(name, decl);
    }
  }

  /**
   * Scan a document for variable usages.
   * Identifies passages in the document and scans non-special ones.
   */
  scanDocument(uri: string, text: string, _macros: MacroNode[]): void {
    // Clear previous usages for this URI
    this.usagesByUri.delete(uri);

    const lines = text.split('\n');
    const usages: VariableUsage[] = [];

    // Find all passage boundaries in the document
    const passageBoundaries: Array<{ name: string; startLine: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      const header = parsePassageHeader(lines[i], i);
      if (header) {
        passageBoundaries.push({ name: header.name, startLine: i });
      }
    }

    // Scan each passage's content
    for (let pi = 0; pi < passageBoundaries.length; pi++) {
      const passage = passageBoundaries[pi];
      if (EXCLUDED_PASSAGES.has(passage.name)) continue;

      const contentStartLine = passage.startLine + 1;
      const contentEndLine = pi + 1 < passageBoundaries.length
        ? passageBoundaries[pi + 1].startLine
        : lines.length;

      const contentLines = lines.slice(contentStartLine, contentEndLine);
      const content = contentLines.join('\n');

      // Clean the content to avoid scanning inside strings/comments
      let cleaned = content;
      for (const pattern of CLEAN_PATTERNS) {
        cleaned = cleaned.replace(pattern, (m) => ' '.repeat(m.length));
      }

      // Build line offsets for this content block
      const lineOffsets: number[] = [0];
      for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === '\n') lineOffsets.push(i + 1);
      }

      // Find variable references
      const re = new RegExp(varRefRegex.source, 'g');
      let match;
      while ((match = re.exec(cleaned)) !== null) {
        const fullName = match[1];
        const baseName = fullName.split('.')[0];
        const charOffset = match.index;

        // Convert offset to line/character within content block
        let localLine = 0;
        for (let i = 0; i < lineOffsets.length; i++) {
          if (lineOffsets[i] > charOffset) break;
          localLine = i;
        }
        const character = charOffset - lineOffsets[localLine];
        const absoluteLine = contentStartLine + localLine;

        const range: Range = {
          start: { line: absoluteLine, character },
          end: { line: absoluteLine, character: character + match[0].length },
        };

        usages.push({ uri, baseName, fullName, range });
      }
    }

    if (usages.length > 0) {
      this.usagesByUri.set(uri, usages);
    }
  }

  /** Get all declared variables. */
  getDeclared(): Map<string, DeclaredVariable> {
    return this.declared;
  }

  /** Get all usages of a variable by base name. */
  getUsages(name: string): Array<{ uri: string; range: Range }> {
    const results: Array<{ uri: string; range: Range }> = [];
    for (const usages of this.usagesByUri.values()) {
      for (const u of usages) {
        if (u.baseName === name) {
          results.push({ uri: u.uri, range: u.range });
        }
      }
    }
    return results;
  }

  /** Get undeclared variable usages in a specific document. */
  getUndeclared(uri: string): Array<{ name: string; range: Range }> {
    const usages = this.usagesByUri.get(uri);
    if (!usages) return [];

    const results: Array<{ name: string; range: Range }> = [];
    const seen = new Set<string>();

    for (const u of usages) {
      if (!this.declared.has(u.baseName) && !seen.has(u.baseName)) {
        seen.add(u.baseName);
        results.push({ name: u.baseName, range: u.range });
      }
    }
    return results;
  }

  /** Whether a StoryVariables passage has been parsed. */
  hasStoryVariables(): boolean {
    return this._hasStoryVariables;
  }
}
