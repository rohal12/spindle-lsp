import { builtinMacros, isBlockMacro, parseCode } from '@rohal12/spindle/tooling';
import type { DeclaredVariable, Position, Range } from '../types.js';
import { collectVariableReferences } from '../parsing/executable-refs.js';
import { DocumentMarkup, type MarkupContext } from '../markup/passage-markup.js';
import { buildLineStarts, offsetToPosition } from '../text.js';
import { PassageIndex } from './passage-index.js';
import { readDeclarations, type DeclarationSigil } from './declaration-check.js';

/**
 * What a tracker that is not given a document's markup knows of the macros:
 * the built-in ones. The workspace passes the markup it reads with its own
 * macros and widgets (see `scanDocument`).
 */
const BUILTIN_CONTEXT: MarkupContext = { macros: builtinMacros, isBlock: isBlockMacro };

function standaloneMarkup(uri: string, text: string): DocumentMarkup {
  const index = new PassageIndex();
  index.rebuild(uri, text);
  return new DocumentMarkup(uri, text, index.getPassagesInDocument(uri), BUILTIN_CONTEXT);
}

/** A StoryVariables / StoryTransients line that stops Spindle from starting. */
export interface InvalidDeclaration {
  message: string;
  range: Range;
}

interface VariableUsage {
  uri: string;
  baseName: string;
  fullName: string;
  range: Range;
}

/** A `$var.member` / `%var.member` access on a variable declared as an array. */
export interface ArrayMemberAccess {
  sigil: '$' | '%';
  name: string;
  member: string;
  range: Range;
}

/**
 * Every property name a JavaScript array has: own and inherited members of
 * Array.prototype, plus recent additions that older Node runtimes may lack.
 */
const ARRAY_MEMBERS: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Array.prototype),
  ...Object.getOwnPropertyNames(Object.prototype),
  'at', 'flat', 'flatMap', 'includes',
  'findLast', 'findLastIndex',
  'toReversed', 'toSorted', 'toSpliced', 'with',
]);

/** The declarations of one special passage, StoryVariables or StoryTransients. */
class DeclarationSet {
  present = false;
  readonly declared = new Map<string, DeclaredVariable>();
  /** Every declaration, including earlier defaults for the same binding. */
  readonly occurrences: DeclaredVariable[] = [];
  /** Lines Spindle rejects. */
  problems: InvalidDeclaration[] = [];
  /** The names declared, with the range of sigil and name of the first. */
  readonly names = new Map<string, Range>();

  constructor(private readonly sigil: DeclarationSigil) {}

  clear(): void {
    this.present = false;
    this.declared.clear();
    this.occurrences.length = 0;
    this.problems = [];
    this.names.clear();
  }

  /** Read the passage `content`, which starts at line `contentStartLine` of the document `uri`. */
  read(content: string, contentStartLine: number, uri: string | undefined): void {
    this.clear();
    this.present = true;
    const { text, declarations, problems } = readDeclarations(content, this.sigil);
    // The text is LF-normalized, but a CR before an LF is the end of its line: columns agree
    const lineStarts = buildLineStarts(text);
    const position = (offset: number): Position => {
      const { line, character } = offsetToPosition(offset, lineStarts);
      return { line: contentStartLine + line, character };
    };

    for (const problem of problems) {
      this.problems.push({ message: problem.message, range: { start: position(problem.start), end: position(problem.end) } });
    }
    for (const declaration of declarations) {
      const { name, schema } = declaration;
      // The range covers the sigil and name, matching the ranges recorded for usages
      const declarationRange = { start: position(declaration.nameStart - 1), end: position(declaration.nameEnd) };
      const declared: DeclaredVariable = { name, sigil: this.sigil, declarationRange };
      if (uri !== undefined) declared.declarationUri = uri;
      if (schema) {
        if (schema.type !== 'null') declared.type = schema.type;
        if (schema.fields && schema.fields.size > 0) declared.fields = [...schema.fields.keys()];
      }
      // A name declared again replaces the first declaration, as when Spindle evaluates them
      this.declared.set(name, declared);
      this.occurrences.push(declared);
      if (!this.names.has(name)) this.names.set(name, declarationRange);
    }
  }
}

/**
 * Tracks declared variables (from StoryVariables and StoryTransients) and
 * variable usages across documents. Declarations are read by the tooling API's
 * `parseDeclarations`, usages from the pieces of code and the tokens of each
 * passage's markup (see `collectVariableReferences`).
 */
export class VariableTracker {
  private readonly variables = new DeclarationSet('$');
  private readonly transients = new DeclarationSet('%');

  /** Per-URI list of variable usages. */
  private usagesByUri = new Map<string, VariableUsage[]>();

  /** Per-URI list of transient variable usages. */
  private transientUsagesByUri = new Map<string, VariableUsage[]>();

  /** Executable assignments can replace a declaration's default shape anywhere in the story. */
  private rootWritesByUri = new Map<string, Set<string>>();

  /**
   * Parse the StoryVariables passage content for declarations.
   * Each line like `$name = value` becomes a declaration.
   */
  parseStoryVariables(content: string, contentStartLine = 0, uri?: string): void {
    this.variables.read(content, contentStartLine, uri);
  }

  /** Forget StoryVariables declarations, e.g. after the passage was removed. */
  clearStoryVariables(): void {
    this.variables.clear();
  }

  /** Forget StoryTransients declarations, e.g. after the passage was removed. */
  clearStoryTransients(): void {
    this.transients.clear();
  }

  /**
   * Parse the StoryTransients passage content for declarations.
   * Each line like `%name = value` becomes a declaration.
   */
  parseStoryTransients(content: string, contentStartLine = 0, uri?: string): void {
    this.transients.read(content, contentStartLine, uri);
  }

  /**
   * Scan a document for variable usages: the `$` and `%` references in the
   * markup of its passages (see `collectVariableReferences`). The workspace
   * passes the `markup` it reads the document with, which knows the project's
   * macros and widgets; without it the built-in macros decide.
   */
  scanDocument(uri: string, text: string, markup: Pick<DocumentMarkup, 'passages'> = standaloneMarkup(uri, text)): void {
    this.removeDocument(uri);
    const usages: VariableUsage[] = [];
    const transientUsages: VariableUsage[] = [];
    const rootWrites = new Set<string>();

    for (const passage of markup.passages) {
      for (const piece of passage.pieces) {
        if (piece.kind !== 'code') continue;
        try {
          for (const ref of parseCode(piece.code, piece.goal).refs) {
            if (ref.write && (ref.sigil === '$' || ref.sigil === '%')) rootWrites.add(ref.sigil + ref.name);
          }
        } catch {
          // Syntax diagnostics own malformed code; it provides no proven write.
        }
      }
      for (const ref of collectVariableReferences(passage)) {
        const usage: VariableUsage = {
          uri,
          baseName: ref.name,
          fullName: ref.path,
          range: passage.range(ref.start, ref.end),
        };
        (ref.sigil === '$' ? usages : transientUsages).push(usage);
      }
    }

    if (usages.length > 0) this.usagesByUri.set(uri, usages);
    if (transientUsages.length > 0) this.transientUsagesByUri.set(uri, transientUsages);
    if (rootWrites.size > 0) this.rootWritesByUri.set(uri, rootWrites);
  }

  /** Forget the usages recorded for a document, e.g. after it was deleted. */
  removeDocument(uri: string): void {
    this.usagesByUri.delete(uri);
    this.transientUsagesByUri.delete(uri);
    this.rootWritesByUri.delete(uri);
  }

  /** Get all declared variables. */
  getDeclared(): Map<string, DeclaredVariable> {
    return this.variables.declared;
  }

  /** Get all usages of a variable by base name. */
  getUsages(name: string): Array<{ uri: string; range: Range }> {
    return usagesOf(this.usagesByUri, name);
  }

  /** Every declaration location of a story or transient binding, in source order. */
  getDeclarations(name: string, sigil: DeclarationSigil): Array<{ uri: string; range: Range }> {
    const declarations = sigil === '$' ? this.variables : this.transients;
    return declarations.occurrences.flatMap(d =>
      d.name === name && d.declarationUri !== undefined && d.declarationRange
        ? [{ uri: d.declarationUri, range: d.declarationRange }] : []);
  }

  /** The executable usage or declaration containing the cursor, in source coordinates. */
  referenceAt(uri: string, position: Position): { sigil: '$' | '%'; name: string; range: Range } | null {
    const contains = (range: Range) =>
      (position.line > range.start.line || (position.line === range.start.line && position.character >= range.start.character)) &&
      (position.line < range.end.line || (position.line === range.end.line && position.character <= range.end.character));
    let atEnd: { sigil: '$' | '%'; name: string; range: Range } | null = null;
    for (const [sigil, usages, declarations] of [
      ['$', this.usagesByUri.get(uri), this.variables.occurrences],
      ['%', this.transientUsagesByUri.get(uri), this.transients.occurrences],
    ] as const) {
      const candidates = (usages ?? []).map(u => ({ name: u.baseName, range: u.range }));
      for (const declaration of declarations) {
        if (declaration.declarationUri === uri && declaration.declarationRange) candidates.push({ name: declaration.name, range: declaration.declarationRange });
      }
      for (const candidate of candidates) {
        if (!contains(candidate.range)) continue;
        const symbol = { sigil, ...candidate };
        if (position.line !== candidate.range.end.line || position.character < candidate.range.end.character) return symbol;
        atEnd ??= symbol;
      }
    }
    return atEnd;
  }

  /** Whether a StoryVariables passage has been parsed. */
  hasStoryVariables(): boolean {
    return this.variables.present;
  }

  /** Get all declared transient variables. */
  getDeclaredTransient(): Map<string, DeclaredVariable> {
    return this.transients.declared;
  }

  /** Get all usages of a transient variable by base name. */
  getTransientUsages(name: string): Array<{ uri: string; range: Range }> {
    return usagesOf(this.transientUsagesByUri, name);
  }

  /** Whether a StoryTransients passage has been parsed. */
  hasStoryTransients(): boolean {
    return this.transients.present;
  }

  /**
   * Get `$var.member` / `%var.member` accesses in a document where `var` is
   * declared with an array literal default, with no known root assignment,
   * and `member` is not a property that JavaScript arrays have.
   */
  getArrayMemberAccesses(uri: string): ArrayMemberAccess[] {
    const results: ArrayMemberAccess[] = [];
    const rootWrites = new Set([...this.rootWritesByUri.values()].flatMap(writes => [...writes]));
    const sources: Array<['$' | '%', VariableUsage[] | undefined, Map<string, DeclaredVariable>]> = [
      ['$', this.usagesByUri.get(uri), this.variables.declared],
      ['%', this.transientUsagesByUri.get(uri), this.transients.declared],
    ];

    for (const [sigil, usages, declared] of sources) {
      for (const u of usages ?? []) {
        const member = u.fullName.split('.')[1];
        if (member === undefined) continue;
        if (declared.get(u.baseName)?.type !== 'array') continue;
        if (rootWrites.has(sigil + u.baseName)) continue;
        // Canonical array indices are properties too, including a path
        // through an element such as $rows.0.name.
        if (ARRAY_MEMBERS.has(member) || (/^(0|[1-9]\d*)$/.test(member) && Number(member) < 0xffffffff)) continue;
        results.push({ sigil, name: u.baseName, member, range: u.range });
      }
    }
    return results;
  }

  /** StoryVariables lines that stop Spindle from starting. */
  getInvalidDeclarations(): InvalidDeclaration[] {
    return this.variables.problems;
  }

  /**
   * StoryTransients lines that stop Spindle from starting, and the names it
   * declares that StoryVariables declares too.
   */
  getInvalidTransientDeclarations(): InvalidDeclaration[] {
    const collisions: InvalidDeclaration[] = [];
    if (this.variables.present) {
      for (const [name, range] of this.transients.names) {
        if (!this.variables.names.has(name)) continue;
        collisions.push({
          message: `StoryTransients: Variable "${name}" is already declared in StoryVariables. ` +
            'Names must be unique across scopes.',
          range,
        });
      }
    }
    return [...this.transients.problems, ...collisions]
      .sort((a, b) => a.range.start.line - b.range.start.line);
  }
}

function usagesOf(byUri: ReadonlyMap<string, VariableUsage[]>, name: string): Array<{ uri: string; range: Range }> {
  const results: Array<{ uri: string; range: Range }> = [];
  for (const usages of byUri.values()) {
    for (const u of usages) {
      if (u.baseName === name) results.push({ uri: u.uri, range: u.range });
    }
  }
  return results;
}
