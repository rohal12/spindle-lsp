import {
  builtinMacros,
  lexJs,
  pairMarkup,
  splitArgs,
  tokenizeMarkupTolerant,
  validateStoryMarkup,
  validateVariableReferences,
  widgetDefinitions,
  type FieldSchema,
  type MacroToken,
  type MarkupDiagnostic,
  type MarkupDiagnosticCode,
  type PairedNode,
  type ToolingMacro,
  type VariableDiagnostic,
  type VariableDiagnosticCode,
  type WidgetDefinition,
} from '@rohal12/spindle/tooling';
import type { Range } from '../core/types.js';
import type { WorkspaceModel } from '../core/workspace/workspace-model.js';
import type { SpindlePlugin, PluginContext } from '../core/plugin/plugin-api.js';
import { DiagnosticCode, getSeverity } from '../core/diagnostic-codes.js';
import type { DiagnosticCodeValue, DiagnosticData, SpindleDiagnostic } from '../core/diagnostic-codes.js';
import type { DocumentMarkup, PassageMarkup } from '../core/markup/passage-markup.js';
import { macroTokens } from './markup-symbols.js';
import { lexArguments } from '../core/parsing/argument-lexer.js';
import { Parameters } from '../core/parsing/parameter-validator.js';
import { findLinkRuntimeMismatches, findLiteralLinkInterpolations } from '../core/parsing/link-parser.js';
import { isScriptOrStylesheetPassage } from '../core/parsing/passage-parser.js';
import { missingStoryVariablesOwner } from '../core/workspace/story-variables-owner.js';
import { isMacroSource } from '../core/workspace/macro-sources.js';
import { unsupportedVersionMessage, type SpindleTarget } from '../core/workspace/spindle-version.js';

// ---------------------------------------------------------------------------
// Core diagnostic function (no LSP dependency)
// ---------------------------------------------------------------------------

/**
 * Compute all diagnostics for a single document within the workspace context.
 *
 * Spindle's own checks come from its tooling API, which applies the rules
 * the runtime applies when the story starts:
 *  - `validateStoryMarkup`: malformed markup (SP101, SP102, SP104, SP105),
 *    unknown macros (SP100), unquoted passage names (SP113), syntax errors in
 *    code (SP106), argument errors (SP109), misplaced branches (SP107) and
 *    passages that do not exist (SP300)
 *  - `validateVariableReferences`: undeclared variables and transients, fields
 *    of primitives, reserved names (SP200, SP201, SP203, SP208)
 *  - `parseDeclarations`, through the variable tracker: declarations Spindle
 *    rejects (SP207)
 *
 * The language server adds what Spindle does not check:
 *  - macros outside the parents they need and children constraints (SP107,
 *    SP114, SP115)
 *  - arguments, against a parameter schema a project configures for a macro
 *    Spindle declares nothing for (SP108-SP111)
 *  - the Spindle version (SP001) and a missing StoryVariables (SP202)
 *  - temporaries assigned in a loop (SP205) and array members (SP206)
 *  - widgets: argument counts, includes of widget passages, unused ones
 *    (SP301, SP302, SP303)
 *  - links the runtime reads differently (SP304, SP305)
 *  - line length (SP500)
 */
export interface DiagnosticOptions {
  maxLineLength?: number;
}

export function computeDiagnostics(uri: string, workspace: WorkspaceModel, options?: DiagnosticOptions): SpindleDiagnostic[] {
  // Don't emit any diagnostics until the full workspace scan is done.
  // Before that, passage/variable/widget indices are incomplete and
  // would produce false positives for cross-file references.
  if (!workspace.initialized) return [];

  // Spindle's rules do not apply to another story format's syntax
  // (SugarCube's <</if>> is not a stray closing tag).
  if (!workspace.isSpindleProject()) return [];

  const doc = workspace.markup.get(uri);
  if (!doc || doc.passages.length === 0) return [];

  const diagnostics: SpindleDiagnostic[] = [];
  // A failure in one category still lets the others report.
  const attempt = (check: () => void) => {
    try {
      check();
    } catch {
      // continue with the other checks
    }
  };

  const story = storyReport(workspace);
  for (const passage of doc.passages) {
    attempt(() => diagnostics.push(...markupDiagnostics(passage, story, workspace)));
    attempt(() => diagnostics.push(...variableDiagnostics(passage, story)));
    attempt(() => diagnostics.push(...structureDiagnostics(passage, workspace)));
    attempt(() => diagnostics.push(...argumentDiagnostics(passage, workspace)));
    attempt(() => diagnostics.push(...widgetDiagnostics(passage, story, workspace)));
  }
  attempt(() => diagnostics.push(...versionDiagnostics(uri, doc, workspace)));
  attempt(() => diagnostics.push(...storyVariablesDiagnostics(uri, doc, story, workspace)));
  attempt(() => diagnostics.push(...arrayMemberDiagnostics(uri, workspace)));
  attempt(() => diagnostics.push(...linkDiagnostics(doc)));
  attempt(() => diagnostics.push(...unusedWidgetDiagnostics(doc, story)));
  if (options?.maxLineLength) {
    const maxLength = options.maxLineLength;
    attempt(() => diagnostics.push(...lineLengthDiagnostics(doc, maxLength)));
  }

  return diagnostics.sort((a, b) =>
    a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

// ---------------------------------------------------------------------------
// The story as the tooling API checks it
// ---------------------------------------------------------------------------

/** A widget the story defines, and the passage that defines it. */
interface DefinedWidget {
  definition: WidgetDefinition;
  passage: PassageMarkup;
}

/**
 * What the checks of the whole story share: they depend on every document, so
 * they are computed once for each version of the workspace's markup (the
 * markup index reads a document again only when it or the project's macros
 * and widgets changed) and kept.
 */
interface StoryReport {
  /** The documents it was computed from. */
  readonly documents: readonly DocumentMarkup[];
  /** The macros the story may use, with the variable an input macro binds. */
  readonly macros: readonly ToolingMacro[];
  /** `validateStoryMarkup`'s diagnostics, by the passage they are in. */
  readonly markup: ReadonlyMap<PassageMarkup, MarkupDiagnostic[]>;
  /** The widgets the story defines, by lower-case name (a later definition replaces an earlier one). */
  readonly widgets: ReadonlyMap<string, DefinedWidget>;
  readonly widgetList: readonly DefinedWidget[];
  /** The lower-case names of the macros the story invokes. */
  readonly invoked: ReadonlySet<string>;
  /** What StoryVariables declares; undefined while the story has no such passage. */
  readonly variables: ReadonlyMap<string, FieldSchema | undefined> | undefined;
  /** What StoryTransients declares; undefined while the story has no such passage. */
  readonly transients: ReadonlyMap<string, FieldSchema | undefined> | undefined;
  /** `validateVariableReferences`, by passage, read when the passage is checked. */
  readonly variableDiagnostics: Map<PassageMarkup, VariableDiagnostic[]>;
}

const reports = new WeakMap<WorkspaceModel, StoryReport>();

/** The passages the compiler turns into story attributes: the runtime never has them. */
const COMPILER_PASSAGES = new Set(['StoryTitle', 'StoryData']);

function storyReport(workspace: WorkspaceModel): StoryReport {
  const documents: DocumentMarkup[] = [];
  for (const uri of workspace.documents.getUris()) {
    if (isMacroSource(uri)) continue;
    const doc = workspace.markup.get(uri);
    if (doc) documents.push(doc);
  }
  const kept = reports.get(workspace);
  if (kept && kept.documents.length === documents.length && kept.documents.every((doc, i) => doc === documents[i])) return kept;
  const report = buildReport(documents, workspace);
  reports.set(workspace, report);
  return report;
}

function buildReport(documents: readonly DocumentMarkup[], workspace: WorkspaceModel): StoryReport {
  const toolingMacros = documents[0]?.context.macros ?? workspace.macros.toolingMacros();
  const macros = toolingMacros.map((macro) => {
    const storeVar = workspace.macros.getMacro(macro.name)?.storeVar;
    return storeVar ? { ...macro, storeVar } : macro;
  });

  const passages: PassageMarkup[] = [];
  for (const doc of documents) {
    for (const passage of doc.passages) {
      if (!COMPILER_PASSAGES.has(passage.passage.name)) passages.push(passage);
    }
  }

  // validateStoryMarkup hands back the `data-source-file` it was given: the index of the passage
  const markup = new Map<PassageMarkup, MarkupDiagnostic[]>();
  const found = validateStoryMarkup(
    passages.map((passage, index) => ({
      name: passage.passage.name,
      content: wellFormed(passage),
      tags: passage.passage.tags,
      metadata: { 'data-source-file': String(index) },
    })),
    toolingMacros,
  );
  for (const diagnostic of found) {
    const passage = passages[Number(diagnostic.file)];
    if (!passage) continue;
    const list = markup.get(passage);
    if (list) list.push(diagnostic);
    else markup.set(passage, [diagnostic]);
  }

  const widgets = new Map<string, DefinedWidget>();
  const widgetList: DefinedWidget[] = [];
  const invoked = new Set<string>();
  for (const passage of passages) {
    if (!passage.isMarkup) continue;
    for (const definition of widgetDefinitions([{ name: passage.passage.name, content: passage.content, tags: passage.passage.tags }], macros)) {
      const widget = { definition, passage };
      widgets.set(definition.name.toLowerCase(), widget);
      widgetList.push(widget);
    }
    for (const token of macroTokens(passage)) {
      if (!token.isClose) invoked.add(token.name.toLowerCase());
    }
  }

  return {
    documents,
    macros,
    markup,
    widgets,
    widgetList,
    invoked,
    variables: declarationsOf(workspace, 'StoryVariables'),
    transients: declarationsOf(workspace, 'StoryTransients'),
    variableDiagnostics: new Map(),
  };
}

/** The names the passage `name` declares with the shape of their default, or undefined if the story has no such passage. */
function declarationsOf(workspace: WorkspaceModel, name: 'StoryVariables' | 'StoryTransients'): Map<string, FieldSchema | undefined> | undefined {
  const passage = name === 'StoryVariables' ? workspace.passages.getStoryVariables() : workspace.passages.getStoryTransients();
  if (!passage) return undefined;
  const markup = workspace.markup.get(passage.uri)?.passages.find((candidate) => candidate.passage === passage);
  if (!markup) return undefined;
  return new Map(markup.declarations.declarations.map((declaration) => [declaration.name, declaration.schema]));
}

// ---------------------------------------------------------------------------
// Markup: validateStoryMarkup
// ---------------------------------------------------------------------------

/** The code each kind of markup diagnostic has (macros and elements are told apart below). */
const MARKUP_CODES: Record<MarkupDiagnosticCode, DiagnosticCodeValue> = {
  'unknown-macro': DiagnosticCode.UndefinedMacro,
  'unclosed-block': DiagnosticCode.MalformedContainer,
  'mismatched-closer': DiagnosticCode.MalformedContainer,
  'stray-closer': DiagnosticCode.MalformedContainer,
  'misplaced-branch': DiagnosticCode.InvalidChildren,
  'invalid-closer': DiagnosticCode.IllegalClosingTag,
  'closer-with-selectors': DiagnosticCode.IllegalClosingTag,
  'closer-with-arguments': DiagnosticCode.IllegalClosingTag,
  'unclosed-tag': DiagnosticCode.MalformedElement,
  'unexpected-character': DiagnosticCode.MalformedElement,
  'unclosed-attribute': DiagnosticCode.MalformedElement,
  'unclosed-link': DiagnosticCode.UnclosedMarkup,
  'unclosed-expression': DiagnosticCode.UnclosedMarkup,
  'unclosed-macro': DiagnosticCode.UnclosedMarkup,
  syntax: DiagnosticCode.UnclosedMarkup,
  'argument-error': DiagnosticCode.ParameterTypeError,
  'code-syntax': DiagnosticCode.CodeSyntaxError,
  'unknown-passage': DiagnosticCode.BrokenPassageLink,
  'unquoted-passage-name': DiagnosticCode.UnquotedPassageName,
};

function markupDiagnostics(passage: PassageMarkup, story: StoryReport, workspace: WorkspaceModel): SpindleDiagnostic[] {
  return [...malformedTags(passage), ...(story.markup.get(passage) ?? [])].map((found) => fromMarkup(passage, found, workspace));
}

/**
 * The malformed tags and the tags that pair with nothing in a passage, all of
 * them, in the shape of `validateStoryMarkup`'s diagnostics. That function
 * reports the first one of a passage, as the story fails to start there (the
 * markup in a label or attribute value is reported by it, one error each).
 */
function malformedTags(passage: PassageMarkup): MarkupDiagnostic[] {
  if (!passage.isMarkup) return [];
  const found: MarkupDiagnostic[] = [];
  const name = passage.passage.name;
  for (const error of passage.tokenization.errors) {
    found.push({ passage: name, line: error.line, column: error.column, message: error.reason, code: error.code, start: error.offset, end: error.end, data: error.data });
  }
  for (const error of passage.pairing.errors) {
    const { line, column } = lineAndColumn(passage.content, error.start);
    found.push({ passage: name, line, column, message: error.message, code: error.code, start: error.start, end: error.end, data: error.data });
  }
  return found.sort((a, b) => a.start - b.start);
}

function lineAndColumn(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, offset);
  return { line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

/**
 * The content of a passage with its malformed tags (and those that pair with
 * nothing) replaced by spaces, so every offset stays. `validateStoryMarkup`
 * stops at the first malformed tag of a passage, as the story fails to start
 * there; read from this copy it goes on to the rest (unknown macros, passages
 * that do not exist, errors in code, ...), which an editor wants alongside.
 */
function wellFormed(passage: PassageMarkup): string {
  if (!passage.isMarkup) return passage.content;
  let content = passage.content;
  let { errors } = passage.tokenization;
  let pairing = passage.pairing.errors;
  // Removing a tag can leave another unpaired: a few rounds settle it
  for (let round = 0; round < 8 && (errors.length > 0 || pairing.length > 0); round++) {
    const chars = Array.from(content);
    const blank = (start: number, end: number) => {
      for (let i = start; i < Math.max(end, start + 1) && i < chars.length; i++) chars[i] = ' ';
    };
    for (const error of errors) blank(error.offset, error.end);
    for (const error of pairing) blank(error.start, error.end);
    content = chars.join('');
    const read = tokenizeMarkupTolerant(content);
    errors = read.errors;
    pairing = pairMarkup(read.tokens, { isBlock: (name) => passage.doc.context.isBlock(name), source: content }).errors;
  }
  return content;
}

function fromMarkup(passage: PassageMarkup, found: MarkupDiagnostic, workspace: WorkspaceModel): SpindleDiagnostic {
  const range = passage.range(...visibleSpan(passage.content, found.start, found.end));
  const name = text(found.data?.name);
  let code = MARKUP_CODES[found.code];
  let data: DiagnosticData | undefined;

  switch (found.code) {
    case 'unknown-macro': {
      const token = [...macroTokens(passage)].find((candidate) => candidate.start === found.start);
      data = {
        kind: 'unknown-macro',
        name,
        suggestions: list(found.data?.suggestions),
        nameRange: token ? passage.range(token.nameStart, token.nameEnd) : range,
      };
      break;
    }
    case 'unknown-passage':
      data = { kind: 'unknown-passage', name, macro: text(found.data?.macro), suggestions: list(found.data?.suggestions) };
      break;
    case 'unquoted-passage-name':
      data = { kind: 'unquoted-passage-name', name, macro: text(found.data?.macro) };
      break;
    case 'unclosed-block':
    case 'mismatched-closer':
    case 'stray-closer': {
      // `{if}` and `</div>` read alike to the pairing; the tag at the diagnostic tells them apart
      const element = passage.content[found.start] === '<';
      if (element) code = DiagnosticCode.MalformedElement;
      else if (found.code === 'stray-closer' && !workspace.isContainer(name)) code = DiagnosticCode.IllegalClosingTag;
      if (found.code === 'unclosed-block') {
        data = { kind: 'unclosed-block', closer: element ? `</${name}>` : `{/${name}}`, at: passage.position(passage.content.trimEnd().length) };
      }
      break;
    }
  }

  return makeDiag(range, code, found.message, data);
}

/**
 * The text a diagnostic underlines. One at the end of the code (`{set $x = }`,
 * "Unexpected end of code") names no text: it underlines the character before
 * it, else the one it stops at.
 */
function visibleSpan(content: string, start: number, end: number): [number, number] {
  if (end > start) return [start, end];
  const visible = (ch: string | undefined) => ch !== undefined && !/\s/.test(ch);
  if (visible(content[start - 1])) return [start - 1, start];
  if (visible(content[start])) return [start, start + 1];
  return [start, end];
}

const text = (value: string | readonly string[] | undefined): string => (typeof value === 'string' ? value : '');
const list = (value: string | readonly string[] | undefined): string[] => (typeof value === 'string' ? [value] : [...(value ?? [])]);

// ---------------------------------------------------------------------------
// Variables: validateVariableReferences (SP200, SP201, SP203, SP208)
// ---------------------------------------------------------------------------

const VARIABLE_CODES: Record<VariableDiagnosticCode, DiagnosticCodeValue> = {
  'undeclared-variable': DiagnosticCode.UndeclaredVariable,
  'undeclared-transient': DiagnosticCode.UndeclaredTransient,
  'primitive-field': DiagnosticCode.PrimitiveFieldAccess,
  'reserved-name': DiagnosticCode.ReservedVariableName,
};

function variableDiagnostics(passage: PassageMarkup, story: StoryReport): SpindleDiagnostic[] {
  const { variables, transients } = story;
  // Without a StoryVariables passage the story does not start (SP202); every `$name` would be undeclared
  if (!passage.isMarkup || COMPILER_PASSAGES.has(passage.passage.name) || (!variables && !transients)) return [];

  let found = story.variableDiagnostics.get(passage);
  if (!found) {
    found = validateVariableReferences(
      [{ name: passage.passage.name, content: passage.content, tags: passage.passage.tags }],
      { variables: variables ?? new Map(), transients },
      story.macros,
    );
    story.variableDiagnostics.set(passage, found);
  }

  return found
    .filter((diagnostic) => variables || (diagnostic.code !== 'undeclared-variable' && diagnostic.code !== 'primitive-field'))
    .map((diagnostic) => {
      const sigil = diagnostic.code === 'undeclared-transient' ? '%' : '$';
      const data: DiagnosticData | undefined = diagnostic.code === 'undeclared-variable' || diagnostic.code === 'undeclared-transient'
        ? { kind: 'undeclared-variable', name: diagnostic.name, sigil }
        : undefined;
      return makeDiag(passage.range(diagnostic.start, diagnostic.end), VARIABLE_CODES[diagnostic.code], diagnostic.message, data);
    });
}

// ---------------------------------------------------------------------------
// StoryVariables declarations (SP202, SP207) and array members (SP206)
// ---------------------------------------------------------------------------

function storyVariablesDiagnostics(uri: string, doc: DocumentMarkup, story: StoryReport, workspace: WorkspaceModel): SpindleDiagnostic[] {
  const diagnostics: SpindleDiagnostic[] = [];

  // SP202: Spindle refuses to start without a StoryVariables passage, whether
  // or not any variable is used. Reported once, on the first story document.
  // A project that does not declare its story format is still being edited,
  // so there it requires a variable usage and stays informational; a declared
  // Spindle story gets an error, since it cannot start.
  if (!workspace.variables.hasStoryVariables() && uri === missingStoryVariablesOwner(workspace)) {
    const declared = workspace.storyFormat !== undefined;
    if (declared || storyUsesVariables(story)) {
      const diagnostic = makeDiag(
        doc.passages[0].passage.range,
        DiagnosticCode.NoStoryVariables,
        'No StoryVariables passage found. Declare all story variables with default values in a StoryVariables passage.',
      );
      if (declared) diagnostic.severity = 'error';
      diagnostics.push(diagnostic);
    }
  }

  // SP207: lines Spindle cannot read as declarations
  const storyVars = workspace.passages.getStoryVariables();
  if (storyVars?.uri === uri) {
    for (const invalid of workspace.variables.getInvalidDeclarations()) {
      diagnostics.push(makeDiag(invalid.range, DiagnosticCode.InvalidDeclaration, `${invalid.message} ${WILL_NOT_START}`));
    }
  }
  const storyTransients = workspace.passages.getStoryTransients();
  if (storyTransients?.uri === uri) {
    for (const invalid of workspace.variables.getInvalidTransientDeclarations()) {
      diagnostics.push(makeDiag(invalid.range, DiagnosticCode.InvalidDeclaration, `${invalid.message} ${WILL_NOT_START}`));
    }
  }
  return diagnostics;
}

const WILL_NOT_START = 'Spindle will not start the story.';

/** Whether any ordinary passage of the story references a `$variable`. */
function storyUsesVariables(story: StoryReport): boolean {
  const excluded = new Set(['StoryVariables', 'StoryInit', 'StoryData', 'StoryScript', 'StoryInterface']);
  return story.documents.some((doc) => doc.passages.some((passage) =>
    passage.isMarkup && !excluded.has(passage.passage.name) &&
    validateVariableReferences(
      [{ name: passage.passage.name, content: passage.content }],
      { variables: new Map() },
      story.macros,
    ).some((diagnostic) => diagnostic.code === 'undeclared-variable')));
}

/**
 * SP206: `$var.name` where `$var` defaults to an array literal in StoryVariables
 * (or `%var.name` in StoryTransients) and `name` is not an array property.
 * Spindle evaluates `$var.name` as plain JavaScript property access, so the
 * result is always `undefined`.
 */
function arrayMemberDiagnostics(uri: string, workspace: WorkspaceModel): SpindleDiagnostic[] {
  return workspace.variables.getArrayMemberAccesses(uri).map((access) => {
    const passage = access.sigil === '%' ? 'StoryTransients' : 'StoryVariables';
    const ref = `${access.sigil}${access.name}`;
    return makeDiag(
      access.range,
      DiagnosticCode.ArrayMemberAccess,
      `'${ref}' is declared as an array in ${passage}, and arrays have no '${access.member}' property: ` +
        `'${ref}.${access.member}' is always undefined. ` +
        `If you meant to test membership, use ${ref}.includes("${access.member}").`,
    );
  });
}

// ---------------------------------------------------------------------------
// Target Spindle version (SP001)
// ---------------------------------------------------------------------------

/**
 * SP001: the detected Spindle is older than the oldest one supported. Reported
 * once per workspace, on the first story document. An undetectable version
 * raises nothing.
 */
function versionDiagnostics(uri: string, doc: DocumentMarkup, workspace: WorkspaceModel): SpindleDiagnostic[] {
  const target: SpindleTarget = workspace.capabilities;
  if (target.supported || uri !== missingStoryVariablesOwner(workspace)) return [];
  const first = doc.passages[0].passage;
  return [makeDiag({ start: first.range.start, end: first.headerEnd.end }, DiagnosticCode.UnsupportedSpindleVersion, unsupportedVersionMessage(target))];
}

// ---------------------------------------------------------------------------
// The tree of a passage: parents and children (SP107, SP114, SP115) and loops (SP205)
// ---------------------------------------------------------------------------

/**
 * Macros Spindle's pairing attaches to their parent itself: `misplaced-branch`
 * (SP107) reports one outside it.
 */
const BRANCH_MACROS = new Set(['elseif', 'else', 'case', 'default', 'next']);

/**
 * Macros that only work as direct children of their parent: {listbox} and
 * {cycle} read their {option}s from their direct children only, so a nested
 * {option} is silently dropped. Other children, such as {stop}, reach their
 * parent through React context and may sit anywhere inside it.
 */
const DIRECT_CHILD_MACROS = new Set(['option']);

/** Containers whose body runs when the user clicks, not when the loop renders. */
const DEFERRED_CONTAINERS = new Set(['link', 'button']);

/** The macro or element a node of the tree is inside. */
interface Ancestor {
  node: PairedNode;
  /** Lower-case macro name or tag name. */
  name: string;
  element: boolean;
}

function structureDiagnostics(passage: PassageMarkup, workspace: WorkspaceModel): SpindleDiagnostic[] {
  const diagnostics: SpindleDiagnostic[] = [];
  if (!passage.isMarkup) return diagnostics;

  const visit = (nodes: readonly PairedNode[], ancestors: readonly Ancestor[]) => {
    for (const node of nodes) {
      const token = node.token;
      if (token.type === 'macro' && !token.isClose) {
        diagnostics.push(...parentDiagnostics(passage, token, ancestors, workspace));
        diagnostics.push(...childDiagnostics(passage, node, token, workspace));
        diagnostics.push(...loopDiagnostics(passage, token, ancestors));
      }
      if (!node.body) continue;
      const inside = [...ancestors, {
        node,
        name: (token.type === 'macro' ? token.name : token.type === 'html' ? token.tag : '').toLowerCase(),
        element: token.type === 'html',
      }];
      visit(node.body.children, inside);
      for (const branch of node.body.branches) visit(branch.children, inside);
    }
  };
  visit(passage.pairing.nodes, []);
  return diagnostics;
}

/** SP107: a macro outside the parents the registry says it needs. */
function parentDiagnostics(passage: PassageMarkup, token: MacroToken, ancestors: readonly Ancestor[], workspace: WorkspaceModel): SpindleDiagnostic[] {
  const name = token.name.toLowerCase();
  const parents = workspace.macros.getMacro(name)?.parents;
  if (!parents || parents.length === 0 || BRANCH_MACROS.has(name)) return [];

  const allowed = new Set(parents.map((parent) => parent.toLowerCase()));
  const parentList = parents.join(', ');
  const range = passage.range(token.start, token.end);
  if (DIRECT_CHILD_MACROS.has(name)) {
    const parent = ancestors[ancestors.length - 1];
    if (parent && !parent.element && allowed.has(parent.name)) return [];
    const where = parent ? (parent.element ? `, not inside <${parent.name}>` : `, not inside {${parent.name}}`) : '';
    return [makeDiag(range, DiagnosticCode.InvalidChildren, `Invalid: {${token.name}} can only be directly inside {${parentList}}${where}`)];
  }
  if (ancestors.some((ancestor) => !ancestor.element && allowed.has(ancestor.name))) return [];
  return [makeDiag(range, DiagnosticCode.InvalidChildren, `Invalid: {${token.name}} can only be inside {${parentList}}`)];
}

/** SP114, SP115: the children a container needs or allows, by the registry's constraints. */
function childDiagnostics(passage: PassageMarkup, node: PairedNode, token: MacroToken, workspace: WorkspaceModel): SpindleDiagnostic[] {
  const constraints = workspace.macros.getMacro(token.name)?.children;
  // A container that is never closed is reported as such
  if (!constraints || constraints.length === 0 || !node.body?.close) return [];

  // The macros directly in the body (also after a branch such as {else}); those in an element or a nested container are its own
  const direct: PairedNode[] = [...node.body.children];
  for (const branch of node.body.branches) direct.push({ token: branch.tag, start: branch.tag.start, end: branch.tag.end }, ...branch.children);
  const counts: Record<string, number> = Object.create(null);
  for (const child of direct) {
    if (child.token.type !== 'macro' || child.token.isClose) continue;
    const key = child.token.name.toLowerCase();
    if (workspace.macros.getMacro(key)) counts[key] = (counts[key] ?? 0) + 1;
  }

  const diagnostics: SpindleDiagnostic[] = [];
  const range = passage.range(token.start, token.end);
  for (const constraint of constraints) {
    const count = counts[constraint.name.toLowerCase()] ?? 0;
    if (constraint.max !== undefined && count > constraint.max) {
      diagnostics.push(makeDiag(range, DiagnosticCode.ChildMaxExceeded,
        `Too many {${constraint.name}} in {${token.name}} (max ${constraint.max}, found ${count})`));
    }
    if (constraint.min !== undefined && count < constraint.min) {
      diagnostics.push(makeDiag(range, DiagnosticCode.ChildMinNotMet,
        `Too few {${constraint.name}} in {${token.name}} (min ${constraint.min}, found ${count})`));
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Temporaries assigned inside {for} (SP205)
// ---------------------------------------------------------------------------

interface TemporaryTarget {
  /** Name without the `_` sigil. */
  name: string;
  /** Offset of the `_` within the macro's raw arguments. */
  offset: number;
}

/** Matches a `_name` temporary reference, using Spindle's own boundary rule. */
function temporaryRefRegex(name: string): RegExp {
  return new RegExp(`(?<![.\\w$@%])_(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w$])`, 'g');
}

/**
 * `code` with the contents of string literals, regular expressions and
 * comments replaced by spaces (keeping the quotes' offsets), so that sigils in
 * them are not mistaken for code. The code in a template literal's `${…}`
 * stays, because Spindle transforms the sigils inside them like any other code.
 */
function maskLiterals(code: string): string {
  const chars: string[] = Array.from(code, (ch) => (ch === '\n' ? '\n' : ' '));
  const copy = (text: string, index: number) => {
    for (let i = 0; i < text.length; i++) chars[index + i] = text[i];
  };
  lexJs(code, {
    code: copy,
    variable: (sigil, name, index) => copy(sigil + name, index),
  }, 'statements');
  return chars.join('');
}

/**
 * The `_name` target of `{computed _name = expr}`, located the way Spindle's
 * parseComputedArgs() does: the first `=` at bracket depth 0 that is not part
 * of `==` or `!=`.
 */
function computedTemporaryTarget(rawArgs: string): TemporaryTarget[] {
  const lead = rawArgs.length - rawArgs.trimStart().length;
  const trimmed = rawArgs.trim();
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) {
      if (trimmed[i + 1] === '=') {
        i++;
        continue;
      }
      if (i > 0 && trimmed[i - 1] === '!') continue;
      const target = trimmed.slice(0, i).trim();
      const m = /^_(\w+)$/.exec(target);
      return m ? [{ name: m[1], offset: lead }] : [];
    }
  }
  return [];
}

/**
 * Plain `_name = expr` assignments in a `{set}` expression. Accumulators are
 * skipped: compound operators (`_n += 1`), `++`/`--`, and assignments whose
 * right-hand side reads the same temporary (`_n = _n + @x`) all deliberately
 * carry a value from one iteration to the next.
 */
function setTemporaryTargets(rawArgs: string): TemporaryTarget[] {
  const code = maskLiterals(rawArgs);
  const targets: TemporaryTarget[] = [];
  const assignRe = /(?<![.\w$@%])_([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(code)) !== null) {
    const name = m[1];
    const rhs = code.slice(m.index + m[0].length, statementEnd(code, m.index + m[0].length));
    if (temporaryRefRegex(name).test(rhs)) continue;
    targets.push({ name, offset: m.index });
  }
  return targets;
}

/** Offset of the `;` or `,` that ends the expression starting at `from`. */
function statementEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if ((ch === ';' || ch === ',') && depth <= 0) return i;
  }
  return code.length;
}

/**
 * SP205: a `_temporary` assigned by `{computed}` or `{set}` inside a `{for}`
 * body and read elsewhere in that body.
 *
 * Spindle keeps temporaries in one store-wide map (`setTemporary`), while
 * `@locals` set inside a loop live in that iteration's own scope. Every
 * iteration therefore writes the same `_name`, and once the passage
 * re-renders all iterations read whichever value was written last.
 * Assignments whose temporary is not read inside the loop (a flag or value
 * handed out to code after the loop) are not reported, nor is one inside a
 * `{link}` or `{button}` between the assignment and the loop: that body runs on
 * click, not once per iteration.
 */
function loopDiagnostics(passage: PassageMarkup, token: MacroToken, ancestors: readonly Ancestor[]): SpindleDiagnostic[] {
  const macro = token.name.toLowerCase();
  if ((macro !== 'computed' && macro !== 'set') || !token.rawArgs) return [];

  let loop: Ancestor | undefined;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (ancestor.element) continue;
    if (DEFERRED_CONTAINERS.has(ancestor.name)) return [];
    if (ancestor.name === 'for') {
      loop = ancestor;
      break;
    }
  }
  const close = loop?.node.body?.close;
  if (!loop || !close) return [];

  const targets = macro === 'computed' ? computedTemporaryTarget(token.rawArgs) : setTemporaryTargets(token.rawArgs);
  const bodyStart = loop.node.token.end;
  const body = passage.content.slice(bodyStart, close.start);
  const diagnostics: SpindleDiagnostic[] = [];
  for (const target of targets) {
    if (!isReadInBody(body, bodyStart, target.name, token.start, token.end)) continue;
    const start = token.argsStart + target.offset;
    diagnostics.push(makeDiag(
      passage.range(start, start + 1 + target.name.length),
      DiagnosticCode.TemporaryAssignedInLoop,
      `Temporary '_${target.name}' is assigned inside {${loop.name}} and read in the loop body. ` +
        'Temporaries are shared by every iteration, so all iterations end up seeing the value ' +
        `assigned by the last one. Use the iteration-local '@${target.name}' instead, ` +
        'or assign it once before the loop if the value does not depend on the iteration.',
    ));
  }
  return diagnostics;
}

/**
 * Whether `_name` is read somewhere in the loop body outside the assigning
 * macro. Occurrences that are themselves plain assignment targets
 * (`_name = …`) do not count as reads.
 */
function isReadInBody(body: string, bodyOffset: number, name: string, macroStart: number, macroEnd: number): boolean {
  const re = temporaryRefRegex(name);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const offset = bodyOffset + m.index;
    if (offset >= macroStart && offset < macroEnd) continue;
    const after = body.slice(m.index + m[0].length);
    if (/^\s*=(?![=>])/.test(after)) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Arguments against a configured parameter schema (SP108-SP111)
// ---------------------------------------------------------------------------

/** Every macro Spindle itself defines, branches included: the tooling API judges their arguments. */
const SPINDLE_MACROS: ReadonlySet<string> = new Set([
  ...builtinMacros.flatMap((macro) => [macro.name, ...macro.subMacros]).map((name) => name.toLowerCase()),
  ...BRANCH_MACROS,
]);

/**
 * Spindle declares the parameters of the macros it defines, and reports
 * arguments that do not have their form (`argument-error`, SP109). A macro
 * that only the project's configuration describes has `parameters` in the
 * registry's format instead, and the language server checks its arguments
 * against those.
 */
function argumentDiagnostics(passage: PassageMarkup, workspace: WorkspaceModel): SpindleDiagnostic[] {
  const diagnostics: SpindleDiagnostic[] = [];
  const passageNames = Array.from(workspace.passages.getAllPassages(), (candidate) => candidate.name);

  for (const token of passage.isMarkup ? passage.tokens : []) {
    if (token.type !== 'macro' || token.isClose) continue;
    const info = workspace.macros.getMacro(token.name);
    if (!info?.parameters || info.skipArgs || SPINDLE_MACROS.has(token.name.toLowerCase())) continue;

    // A malformed parameter schema only disables the checks of its own macro.
    let params: Parameters;
    try {
      params = new Parameters(info.parameters);
    } catch {
      continue;
    }
    const range = passage.range(token.start, token.end);
    const args = lexArguments(token.rawArgs);

    // SP108: no parameters, but arguments
    if (params.isEmpty()) {
      if (args.length > 0) {
        diagnostics.push(makeDiag(range, DiagnosticCode.ExpectedNoArguments, `Expected no arguments for {${token.name}}, got ${args.length}`));
      }
      continue;
    }

    const result = params.validate(args, { passages: passageNames });
    if (result.variantIndex === null) continue;
    for (const error of result.errors) {
      const code = error.message.startsWith('Too many arguments') ? DiagnosticCode.TooManyArguments : DiagnosticCode.ParameterTypeError;
      diagnostics.push(makeDiag(range, code, `{${token.name}}: ${error.message}`));
    }
    for (const warning of result.warnings) {
      diagnostics.push(makeDiag(range, DiagnosticCode.ParameterWarning, `{${token.name}}: ${warning.message}`));
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Widgets (SP301, SP302, SP303)
// ---------------------------------------------------------------------------

/** SP301 (argument count of an invocation) and SP302 ({include} of a passage that defines widgets). */
function widgetDiagnostics(passage: PassageMarkup, story: StoryReport, workspace: WorkspaceModel): SpindleDiagnostic[] {
  if (!passage.isMarkup) return [];
  const diagnostics: SpindleDiagnostic[] = [];
  const macros = [...macroTokens(passage)];

  for (const token of macros) {
    if (token.isClose) continue;
    // A macro of the same name is no widget invocation
    if (workspace.macros.getMacro(token.name)) continue;
    const widget = story.widgets.get(token.name.toLowerCase());
    if (!widget) continue;
    // The runtime splits the arguments of an invocation with splitArgs
    const got = token.rawArgs ? splitArgs(token.rawArgs).length : 0;
    const expected = widget.definition.params.length;
    if (got !== expected) {
      diagnostics.push(makeDiag(
        passage.range(token.start, token.end),
        DiagnosticCode.WidgetArgCountMismatch,
        `Widget {${token.name}} expects ${expected} argument(s), got ${got}`,
      ));
    }
  }

  // SP302: Spindle registers the {widget} definitions of a [widget] passage at
  // startup; when the passage is included, each {widget} macro renders
  // nothing, so none of the widgets' output appears. (A passage that defines
  // no widgets renders its content like any other and is not reported.) Only a
  // passage name written out is a target: a bare `{include Other}` is an
  // expression.
  for (const piece of passage.pieces) {
    if (piece.kind !== 'passage' || piece.macro !== 'include') continue;
    const target = workspace.passages.getPassage(piece.name);
    if (!target?.tags?.includes('widget')) continue;
    const defined = story.widgetList.filter((widget) => widget.passage.passage === target).map((widget) => widget.definition.name);
    if (defined.length === 0) continue;
    const include = macros.find((token) => !token.isClose && token.name.toLowerCase() === 'include' && token.start <= piece.offset && piece.offset < token.end);
    if (!include) continue;

    const names = defined.map((name) => `{${name}}`).join(', ');
    diagnostics.push(makeDiag(
      passage.range(include.start, include.end),
      DiagnosticCode.IncludeWidgetPassage,
      `{include}: passage "${piece.name}" is tagged [widget] and defines ${names}. ` +
        `Including it does not invoke ${defined.length === 1 ? 'it' : 'them'}: {widget} definitions render nothing. ` +
        `Invoke the widget instead, e.g. {${defined[0]}}.`,
    ));
  }
  return diagnostics;
}

/**
 * SP303: a widget defined in this document that no passage of the workspace
 * invokes as `{name}`. Matching is case-insensitive, like Spindle's widget
 * lookup. Invocations from JavaScript-generated markup cannot be seen, hence
 * hint severity.
 */
function unusedWidgetDiagnostics(doc: DocumentMarkup, story: StoryReport): SpindleDiagnostic[] {
  const diagnostics: SpindleDiagnostic[] = [];
  for (const { definition, passage } of story.widgetList) {
    if (passage.doc !== doc || story.widgets.get(definition.name.toLowerCase())?.definition !== definition) continue;
    if (story.invoked.has(definition.name.toLowerCase())) continue;
    diagnostics.push(makeDiag(
      passage.range(definition.start, definition.end),
      DiagnosticCode.UnusedWidget,
      `Widget "${definition.name}" is defined but never invoked in the workspace`,
    ));
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Links the runtime reads differently (SP304, SP305)
// ---------------------------------------------------------------------------

/** How a click on a link navigates, for a message. */
function describeNavigation(passage: string | null): string {
  if (passage === null) return 'navigates nowhere';
  if (passage === '') return 'navigates nowhere (the passage name it reads is empty)';
  return `navigates to ${JSON.stringify(passage)}`;
}

function linkDiagnostics(doc: DocumentMarkup): SpindleDiagnostic[] {
  const diagnostics: SpindleDiagnostic[] = [];

  // SP304: the link macro, which renders every bracket link, reads its quoted
  // arguments as JavaScript string literals; a target with a line break is none,
  // and a click on the link fails (see core/parsing/link-runtime.ts).
  for (const link of findLinkRuntimeMismatches(doc.text)) {
    diagnostics.push(makeDiag(
      link.range,
      DiagnosticCode.LinkRuntimeMismatch,
      'Spindle reads this link differently from how it is written: the link macro reads ' +
        `the label as ${JSON.stringify(link.runtime.display)} and a click ${describeNavigation(link.runtime.passage)}, ` +
        `not to ${JSON.stringify(link.target)}.`,
    ));
  }

  // SP305: the link macro prints the label and navigates to the passage exactly
  // as written. It interpolates the link's `.class#id` selectors and the markup
  // of its label, but not the passage name: `[[Go->T{$n}]]` goes to a passage
  // named `T{$n}`.
  for (const found of findLiteralLinkInterpolations(doc.text)) {
    diagnostics.push(makeDiag(
      found.range,
      DiagnosticCode.LiteralLinkInterpolation,
      `Spindle does not interpolate ${found.block} in the passage name of a link: the passage name a click navigates to ` +
        'contains it as written, braces included. The label, the class/id selectors and HTML attributes of a link ' +
        'are interpolated; to build a passage name from a variable use an expression, as in `{link "Go" "T" + $n}`, ' +
        'or write the name as plain text.',
    ));
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Line-length validation (SP500)
// ---------------------------------------------------------------------------

function lineLengthDiagnostics(doc: DocumentMarkup, maxLength: number): SpindleDiagnostic[] {
  // Skip script/stylesheet passages — those have their own formatting rules
  const excludedLines = new Set<number>();
  for (const { passage } of doc.passages.filter(({ passage }) => isScriptOrStylesheetPassage(passage))) {
    for (let i = passage.range.start.line; i <= passage.range.end.line; i++) excludedLines.add(i);
  }

  const diagnostics: SpindleDiagnostic[] = [];
  const lines = doc.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (excludedLines.has(i)) continue;
    const line = lines[i];
    // Skip passage headers
    if (/^﻿?::\s+/.test(line)) continue;
    // Skip HTML-heavy lines (tags with attributes)
    if (/^\s*<[a-zA-Z]/.test(line)) continue;

    if (line.length > maxLength) {
      diagnostics.push(makeDiag(
        { start: { line: i, character: maxLength }, end: { line: i, character: line.length } },
        DiagnosticCode.LineTooLong,
        `Line exceeds ${maxLength} characters (${line.length})`,
      ));
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiag(range: Range, code: DiagnosticCodeValue, message: string, data?: DiagnosticData): SpindleDiagnostic {
  const diagnostic: SpindleDiagnostic = {
    range,
    message,
    severity: getSeverity(code),
    code,
    source: 'spindle',
  };
  if (data) diagnostic.data = data;
  return diagnostic;
}

// ---------------------------------------------------------------------------
// Plugin wrapper (LSP integration)
// ---------------------------------------------------------------------------

function toLspDiagnostic(d: SpindleDiagnostic): import('vscode-languageserver').Diagnostic {
  const severityMap = {
    error: 1,
    warning: 2,
    info: 3,
    hint: 4,
  } as const;

  return {
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    severity: severityMap[d.severity],
    code: d.code,
    source: d.source,
    message: d.message,
    data: d.data,
  };
}

export const diagnosticsPlugin: SpindlePlugin = {
  id: 'diagnostics',
  capabilities: {},
  initialize(ctx: PluginContext) {
    // Per-code enable/disable map, e.g. { SP100: false }
    const isEnabled = (d: SpindleDiagnostic) => ctx.config.diagnostics?.[d.code] !== false;

    const publishFor = (uri: string) => {
      const diags = computeDiagnostics(uri, ctx.workspace);
      ctx.connection.sendDiagnostics({
        uri,
        diagnostics: diags.filter(isEnabled).map(d => toLspDiagnostic(d)),
      });
    };

    const publishAll = () => {
      for (const uri of ctx.workspace.documents.getUris()) {
        if (isMacroSource(uri)) continue;
        publishFor(uri);
      }
    };

    ctx.workspace.on('modelReady', publishAll);
    // Switching the story format to or from Spindle changes the diagnostics
    // of every document, not just the edited StoryData file.
    ctx.workspace.on('storyFormatChanged', publishAll);
    ctx.workspace.on('documentChanged', publishFor);
    // A document that left the store won't be republished — clear its
    // diagnostics so the editor drops stale problems.
    ctx.workspace.on('documentClosed', (uri: string) => {
      ctx.connection.sendDiagnostics({ uri, diagnostics: [] });
    });
  },
};
