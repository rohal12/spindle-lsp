import { builtinMacros, isBlockMacro, type FieldSchema } from '@rohal12/spindle/tooling';
import type { DeclaredVariable, Position, Range, VariableValueType } from '../types.js';
import { collectVariableReferences } from '../parsing/executable-refs.js';
import { DocumentMarkup, type MarkupContext } from '../markup/passage-markup.js';
import { buildLineStarts, offsetToPosition } from '../text.js';
import { PassageIndex } from './passage-index.js';
import { readDeclarations, type DeclarationSigil } from './declaration-check.js';
import { findPrimitiveFieldAccess } from './variable-schema.js';

/**
 * `StoryScript` is not a passage Spindle treats specially (it validates its
 * references), but its text is script, not an executable usage (C-V73).
 */
const STORY_SCRIPT_PASSAGE = 'StoryScript';

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

interface NullDeclaration {
  name: string;
  sigil: '$' | '%';
  /** The object fields whose value is null, when it is not the whole default. */
  field?: string[];
  range: Range;
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
  /** Whether rename and references list it (StoryScript is not markup to them). */
  indexed: boolean;
  /** Whether Spindle's startup validation checks it. */
  validated: boolean;
}

/**
 * A `$var.a.b` path Spindle rejects at startup: `field` is accessed on
 * `path` (e.g. `$var.a`), whose StoryVariables default is a primitive.
 */
export interface PrimitiveFieldAccess {
  path: string;
  field: string;
  type: VariableValueType;
  /** Range of the rejected field name. */
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
  /** The static schema of each declaration whose default has one. */
  readonly schemas = new Map<string, FieldSchema>();
  /** Lines Spindle rejects. */
  problems: InvalidDeclaration[] = [];
  /** The names declared, with the range of sigil and name of the first. */
  readonly names = new Map<string, Range>();

  constructor(private readonly sigil: DeclarationSigil) {}

  clear(): void {
    this.present = false;
    this.declared.clear();
    this.schemas.clear();
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
        this.schemas.set(name, schema);
      } else {
        this.schemas.delete(name);
      }
      // A name declared again replaces the first declaration, as when Spindle evaluates them
      this.declared.set(name, declared);
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
   *
   * `_macros` and `_storeVarMacros` are not read any more (a macro's
   * `storeVar` flag says which macros bind a variable).
   * @deprecated Pass only `markup`; drop the other arguments with their callers.
   */
  scanDocument(
    uri: string,
    text: string,
    _macros?: readonly unknown[],
    _storeVarMacros?: ReadonlySet<string>,
    markup: DocumentMarkup = standaloneMarkup(uri, text),
  ): void {
    this.removeDocument(uri);
    const usages: VariableUsage[] = [];
    const transientUsages: VariableUsage[] = [];

    for (const passage of markup.passages) {
      const indexed = passage.passage.name !== STORY_SCRIPT_PASSAGE;
      for (const ref of collectVariableReferences(passage)) {
        const usage: VariableUsage = {
          uri,
          baseName: ref.name,
          fullName: ref.path,
          range: passage.range(ref.start, ref.end),
          indexed,
          validated: ref.validated,
        };
        (ref.sigil === '$' ? usages : transientUsages).push(usage);
      }
    }

    if (usages.length > 0) this.usagesByUri.set(uri, usages);
    if (transientUsages.length > 0) this.transientUsagesByUri.set(uri, transientUsages);
  }

  /** Forget the usages recorded for a document, e.g. after it was deleted. */
  removeDocument(uri: string): void {
    this.usagesByUri.delete(uri);
    this.transientUsagesByUri.delete(uri);
  }

  /** Get all declared variables. */
  getDeclared(): Map<string, DeclaredVariable> {
    return this.variables.declared;
  }

  /** Get all usages of a variable by base name. */
  getUsages(name: string): Array<{ uri: string; range: Range }> {
    return indexedUsages(this.usagesByUri, name);
  }

  /**
   * Get undeclared variable references in a specific document: the ones
   * Spindle rejects when the story starts.
   */
  getUndeclared(uri: string): Array<{ name: string; range: Range }> {
    return undeclared((this.usagesByUri.get(uri) ?? []).filter(u => u.validated), this.variables.declared);
  }

  /**
   * Get the `$var.a.b` paths in a document that Spindle rejects at startup
   * because they access a field of a number, string or boolean, judged by
   * the StoryVariables defaults as Spindle's startup validation does
   * (members of the primitive's wrapper such as `$s.length` are allowed).
   * Every occurrence is reported; defaults that are not static are not
   * checked.
   */
  getPrimitiveFieldAccesses(uri: string): PrimitiveFieldAccess[] {
    const results: PrimitiveFieldAccess[] = [];
    for (const ref of this.usagesByUri.get(uri) ?? []) {
      const schema = ref.validated ? this.variables.schemas.get(ref.baseName) : undefined;
      if (!schema) continue;
      const parts = ref.fullName.split('.');
      const found = findPrimitiveFieldAccess(schema, parts.slice(1));
      if (!found) continue;

      const owner = parts.slice(0, found.index + 1).join('.');
      const field = parts[found.index + 1];
      const start = ref.range.start.character + 1 + owner.length + 1;
      results.push({
        path: `$${owner}`,
        field,
        type: found.type,
        range: {
          start: { line: ref.range.start.line, character: start },
          end: { line: ref.range.start.line, character: start + field.length },
        },
      });
    }
    return results;
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
    return indexedUsages(this.transientUsagesByUri, name);
  }

  /** Get undeclared transient variable usages in a specific document. */
  getUndeclaredTransient(uri: string): Array<{ name: string; range: Range }> {
    return undeclared((this.transientUsagesByUri.get(uri) ?? []).filter(u => u.indexed), this.transients.declared);
  }

  /** Whether a StoryTransients passage has been parsed. */
  hasStoryTransients(): boolean {
    return this.transients.present;
  }

  /**
   * Get `$var.member` / `%var.member` accesses in a document where `var` is
   * declared with an array literal default and `member` is not a property
   * that JavaScript arrays have (so the access always yields undefined).
   */
  getArrayMemberAccesses(uri: string): ArrayMemberAccess[] {
    const results: ArrayMemberAccess[] = [];
    const sources: Array<['$' | '%', VariableUsage[] | undefined, Map<string, DeclaredVariable>]> = [
      ['$', this.usagesByUri.get(uri), this.variables.declared],
      ['%', this.transientUsagesByUri.get(uri), this.transients.declared],
    ];

    for (const [sigil, usages, declared] of sources) {
      for (const u of usages ?? []) {
        const member = u.fullName.split('.')[1];
        if (!u.indexed || member === undefined) continue;
        if (declared.get(u.baseName)?.type !== 'array') continue;
        if (ARRAY_MEMBERS.has(member)) continue;
        results.push({ sigil, name: u.baseName, member, range: u.range });
      }
    }
    return results;
  }

  /**
   * Variables declared with null values in StoryVariables. Spindle accepts a
   * `null` default (type `null`: it may hold anything later), so there are none.
   * @deprecated Nothing reports null defaults any more; delete with SP204.
   */
  getNullDeclarations(): NullDeclaration[] {
    return [];
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

  /**
   * Transient variables declared with null values in StoryTransients.
   * @deprecated See getNullDeclarations().
   */
  getNullTransientDeclarations(): NullDeclaration[] {
    return [];
  }
}

function indexedUsages(byUri: ReadonlyMap<string, VariableUsage[]>, name: string): Array<{ uri: string; range: Range }> {
  const results: Array<{ uri: string; range: Range }> = [];
  for (const usages of byUri.values()) {
    for (const u of usages) {
      if (u.indexed && u.baseName === name) results.push({ uri: u.uri, range: u.range });
    }
  }
  return results;
}

/** The first usage of each name that is not declared. */
function undeclared(
  usages: readonly VariableUsage[],
  declared: ReadonlyMap<string, DeclaredVariable>,
): Array<{ name: string; range: Range }> {
  const results: Array<{ name: string; range: Range }> = [];
  const seen = new Set<string>();
  for (const u of usages) {
    if (declared.has(u.baseName) || seen.has(u.baseName)) continue;
    seen.add(u.baseName);
    results.push({ name: u.baseName, range: u.range });
  }
  return results;
}
