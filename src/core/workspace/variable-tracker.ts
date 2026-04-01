import type { DeclaredVariable, MacroNode, Range, Position } from '../types.js';
import { parsePassageHeader } from '../parsing/passage-parser.js';

/** Regex to match $variable references including dot notation. */
const varRefRegex = /\$([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;

/** Regex to match %transient variable references including dot notation. */
const transientRefRegex = /(?<!\w)%([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g;

/** Passages excluded from variable scanning. */
const EXCLUDED_PASSAGES = new Set([
  'StoryVariables', 'StoryTransients', 'StoryInit', 'StoryData', 'StoryScript', 'StoryInterface',
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

interface NullDeclaration {
  name: string;
  sigil: '$' | '%';
  range: Range;
}

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
  private _nullDeclarations: NullDeclaration[] = [];

  private declaredTransient = new Map<string, DeclaredVariable>();
  private _hasStoryTransients = false;
  private _nullTransientDeclarations: NullDeclaration[] = [];

  /** Per-URI list of variable usages. */
  private usagesByUri = new Map<string, VariableUsage[]>();

  /** Per-URI list of transient variable usages. */
  private transientUsagesByUri = new Map<string, VariableUsage[]>();

  /**
   * Parse the StoryVariables passage content for declarations.
   * Each line like `$name = value` becomes a declaration.
   */
  parseStoryVariables(content: string, contentStartLine = 0): void {
    this.declared.clear();
    this._hasStoryVariables = true;
    this._nullDeclarations = [];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('<!--')) continue;

      const match = /^\$([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;

      const name = match[1];
      const expr = match[2].trim();

      // Detect null values — Spindle doesn't support null
      if (expr === 'null') {
        const charIdx = lines[i].indexOf('null', lines[i].indexOf('='));
        const absLine = contentStartLine + i;
        this._nullDeclarations.push({
          name,
          sigil: '$',
          range: {
            start: { line: absLine, character: charIdx },
            end: { line: absLine, character: charIdx + 4 },
          },
        });
        // Still register as declared so we don't also emit SP200
        this.declared.set(name, { name, sigil: '$' });
        continue;
      }

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
   * Parse the StoryTransients passage content for declarations.
   * Each line like `%name = value` becomes a declaration.
   */
  parseStoryTransients(content: string, contentStartLine = 0): void {
    this.declaredTransient.clear();
    this._hasStoryTransients = true;
    this._nullTransientDeclarations = [];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('<!--')) continue;

      const match = /^%([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;

      const name = match[1];
      const expr = match[2].trim();

      // Detect null values — Spindle doesn't support null
      if (expr === 'null') {
        const charIdx = lines[i].indexOf('null', lines[i].indexOf('='));
        const absLine = contentStartLine + i;
        this._nullTransientDeclarations.push({
          name,
          sigil: '%',
          range: {
            start: { line: absLine, character: charIdx },
            end: { line: absLine, character: charIdx + 4 },
          },
        });
        this.declaredTransient.set(name, { name, sigil: '%' });
        continue;
      }

      const decl: DeclaredVariable = { name, sigil: '%' };

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

      this.declaredTransient.set(name, decl);
    }
  }

  /**
   * Scan a document for variable usages.
   * Identifies passages in the document and scans non-special ones.
   */
  scanDocument(uri: string, text: string, _macros: MacroNode[]): void {
    // Clear previous usages for this URI
    this.usagesByUri.delete(uri);
    this.transientUsagesByUri.delete(uri);

    const lines = text.split('\n');
    const usages: VariableUsage[] = [];
    const transientUsages: VariableUsage[] = [];

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

      // Find transient variable references
      const tre = new RegExp(transientRefRegex.source, 'g');
      let tmatch;
      while ((tmatch = tre.exec(cleaned)) !== null) {
        const fullName = tmatch[1];
        const baseName = fullName.split('.')[0];
        const charOffset = tmatch.index;

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
          end: { line: absoluteLine, character: character + tmatch[0].length },
        };

        transientUsages.push({ uri, baseName, fullName, range });
      }
    }

    if (usages.length > 0) {
      this.usagesByUri.set(uri, usages);
    }
    if (transientUsages.length > 0) {
      this.transientUsagesByUri.set(uri, transientUsages);
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

  /** Get all declared transient variables. */
  getDeclaredTransient(): Map<string, DeclaredVariable> {
    return this.declaredTransient;
  }

  /** Get all usages of a transient variable by base name. */
  getTransientUsages(name: string): Array<{ uri: string; range: Range }> {
    const results: Array<{ uri: string; range: Range }> = [];
    for (const usages of this.transientUsagesByUri.values()) {
      for (const u of usages) {
        if (u.baseName === name) {
          results.push({ uri: u.uri, range: u.range });
        }
      }
    }
    return results;
  }

  /** Get undeclared transient variable usages in a specific document. */
  getUndeclaredTransient(uri: string): Array<{ name: string; range: Range }> {
    const usages = this.transientUsagesByUri.get(uri);
    if (!usages) return [];

    const results: Array<{ name: string; range: Range }> = [];
    const seen = new Set<string>();

    for (const u of usages) {
      if (!this.declaredTransient.has(u.baseName) && !seen.has(u.baseName)) {
        seen.add(u.baseName);
        results.push({ name: u.baseName, range: u.range });
      }
    }
    return results;
  }

  /** Whether a StoryTransients passage has been parsed. */
  hasStoryTransients(): boolean {
    return this._hasStoryTransients;
  }

  /** Get variables declared with null values in StoryVariables. */
  getNullDeclarations(): NullDeclaration[] {
    return this._nullDeclarations;
  }

  /** Get transient variables declared with null values in StoryTransients. */
  getNullTransientDeclarations(): NullDeclaration[] {
    return this._nullTransientDeclarations;
  }
}
