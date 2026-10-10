import {
  builtinMacros,
  findCodeEnd,
  lexJs,
  passagePieces,
  readQuoted,
  splitTopLevel,
  type ParameterDef,
  type ParameterType,
  type StringHolds,
} from '@rohal12/spindle/tooling';

export interface DiscoveredMacro {
  name: string;
  block?: boolean;
  subMacros?: string[];
  storeVar?: boolean;
  merged?: boolean;
  interpolate?: boolean;
  description?: string;
  /** The typed parameters of the definition, when it declares them. */
  parameters?: ParameterDef[];
}

/** Locates `Story.defineMacro({` call sites. */
const defineMacroRegex = /Story\.defineMacro\s*\(\s*\{/g;

/** A property of an object literal: `key: value` (shorthand properties and methods have none). */
const PROPERTY = /^\s*(?:(["'])(.*?)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*?)\s*$/;

/** `source` with its comments blanked (line breaks kept). */
function withoutComments(source: string): string {
  let out = '';
  lexJs(source, {
    code: (ch) => { out += ch; },
    literal: (text) => { out += /^\/[/*]/.test(text) ? text.replace(/[^\r\n]/g, ' ') : text; },
  });
  return out;
}

/** The `key: value` properties of the object literal `source`, `{...}`, by key; values as written. */
function properties(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of splitTopLevel(source.slice(1, -1), (ch) => ch === ',')) {
    const match = PROPERTY.exec(entry);
    if (match && !found.has(match[2] ?? match[3])) found.set(match[2] ?? match[3], match[4]);
  }
  return found;
}

function stringValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const quoted = readQuoted(value, 0);
  return quoted && quoted.end === value.length ? quoted.value : undefined;
}

function booleanValue(value: string | undefined): boolean | undefined {
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

/** The elements of the array literal `value`, as written; none for anything else. */
function elements(value: string | undefined): string[] {
  if (value === undefined || !value.startsWith('[') || !value.endsWith(']')) return [];
  return splitTopLevel(value.slice(1, -1), (ch) => ch === ',').map((element) => element.trim()).filter((element) => element !== '');
}

const PARAMETER_TYPES: ReadonlySet<string> = new Set<ParameterType>([
  'expression', 'statements', 'passage', 'variable', 'string', 'text', 'names', 'delay', 'number', 'flag', 'separator', 'options',
]);
const STRING_HOLDS: ReadonlySet<string> = new Set<StringHolds>(['markup', 'text', 'passage', 'expression', 'statements']);

/** One declared parameter; undefined when it has no name or no known type (Spindle throws for those). */
function parameterDef(source: string): ParameterDef | undefined {
  if (!source.startsWith('{') || !source.endsWith('}')) return undefined;
  const fields = properties(source);
  const name = stringValue(fields.get('name'));
  const type = stringValue(fields.get('type'));
  if (name === undefined || type === undefined || !PARAMETER_TYPES.has(type)) return undefined;

  const def: ParameterDef = { name, type: type as ParameterType };
  const required = booleanValue(fields.get('required'));
  if (required !== undefined) def.required = required;
  const description = stringValue(fields.get('description'));
  if (description !== undefined) def.description = description;
  const holds = stringValue(fields.get('holds'));
  if (holds !== undefined && STRING_HOLDS.has(holds)) def.holds = holds as StringHolds;
  const options = parameterDefs(fields.get('parameters'));
  if (options) def.parameters = options;
  return def;
}

/** The parameters of an array literal; undefined if there is none or one of them cannot be read. */
function parameterDefs(value: string | undefined): ParameterDef[] | undefined {
  const defs = elements(value).map(parameterDef);
  if (value === undefined || !value.startsWith('[') || defs.includes(undefined)) return undefined;
  return defs as ParameterDef[];
}

/** The static fields of a `Story.defineMacro` config object `{...}`. */
function parseConfigFields(config: string): DiscoveredMacro | null {
  const fields = properties(config);
  const name = stringValue(fields.get('name'));
  if (name === undefined || name === '') return null;

  const macro: DiscoveredMacro = { name };
  for (const flag of ['block', 'storeVar', 'merged', 'interpolate'] as const) {
    const value = booleanValue(fields.get(flag));
    if (value !== undefined) macro[flag] = value;
  }
  const description = stringValue(fields.get('description'));
  if (description !== undefined) macro.description = description;

  const subMacros = elements(fields.get('subMacros')).map(stringValue).filter((sub): sub is string => !!sub);
  if (subMacros.length > 0) macro.subMacros = subMacros;
  const parameters = parameterDefs(fields.get('parameters'));
  if (parameters) macro.parameters = parameters;
  return macro;
}

/**
 * Discover macro definitions from JS/TS source code that contains
 * Story.defineMacro({...}) calls.
 */
export function discoverMacrosFromSource(source: string): DiscoveredMacro[] {
  const macros: DiscoveredMacro[] = [];

  for (const match of source.matchAll(defineMacroRegex)) {
    // The '{' is the last character of the match
    const open = match.index + match[0].length - 1;
    const close = findCodeEnd(source, open + 1);
    if (close === -1) continue;
    const macro = parseConfigFields(withoutComments(source.slice(open, close + 1)));
    if (macro) macros.push(macro);
  }

  return macros;
}

/**
 * Discover macro definitions from StoryInit passage content: the code of
 * its macros (the `{do}` bodies, where `Story.defineMacro()` calls live), as
 * the tooling API finds them.
 */
export function discoverMacrosFromStoryInit(passageContent: string): DiscoveredMacro[] {
  return passagePieces(passageContent, builtinMacros)
    .flatMap((piece) => piece.kind === 'code' && piece.goal === 'statements' ? discoverMacrosFromSource(piece.code) : []);
}
