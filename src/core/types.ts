export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface MacroNode {
  id: number;
  pair: number;
  name: string;
  open: boolean;
  range: Range;
  cssPrefix?: string;
  rawArgs?: string;
  /**
   * Set by pairMacros() on a closer that crosses a container still to be
   * closed: the name of the container on top of the stack, which Spindle's
   * buildAST expects to be closed first.
   */
  expected?: string;
}

export interface MacroInfo {
  name: string;
  block: boolean;
  subMacros: string[];
  storeVar?: boolean;
  interpolate?: boolean;
  merged?: boolean;
  source: 'builtin' | 'user';
  description?: string;
  parameters?: string[];
  children?: ChildConstraint[];
  parents?: string[];
  skipArgs?: boolean;
}

export interface ChildConstraint {
  name: string;
  min?: number;
  max?: number;
}

export interface Passage {
  name: string;
  range: Range;
  headerEnd: Range;
  /** Range of the passage name within its header line. */
  nameRange: Range;
  uri: string;
  tags?: string[];
  meta?: Record<string, unknown>;
}

export interface Diagnostic {
  range: Range;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  code: string;
  source: string;
}

/**
 * Runtime type of a declared variable's default value, mirroring the
 * `VarType` Spindle infers from StoryVariables/StoryTransients defaults.
 */
export type VariableValueType = 'array' | 'object' | 'string' | 'number' | 'boolean';

/**
 * The schema Spindle's inferSchema() (story-variables.ts) gives a
 * StoryVariables default: its type and, for an object, the schema of each
 * own field. Spindle checks every `$a.b.c` path in the story against it when
 * the story starts.
 */
export interface ValueSchema {
  type: VariableValueType;
  /**
   * An object's own fields: each maps to its schema, or to null when its
   * value is not a literal whose type is known without evaluating it.
   * Absent when the object's fields are unknown (a spread, a computed key,
   * an accessor or a method decides them).
   */
  fields?: Map<string, ValueSchema | null>;
}

export interface DeclaredVariable {
  name: string;
  sigil: '$' | '_' | '@' | '%';
  fields?: string[];
  /** Type of the default value, set only when the default is a single literal. */
  type?: VariableValueType;
  /** Schema Spindle infers from a StoryVariables default, set only when the default is a literal. */
  schema?: ValueSchema;
  declarationUri?: string;
  declarationRange?: Range;
}

export interface WidgetDef {
  name: string;
  /** Declared parameters including their sigil, e.g. `@name`, `$x`, `_y`. */
  params: string[];
  uri: string;
  /** Range of the whole `{widget ...}` opening tag. */
  range: Range;
  /** Range of the widget name inside the definition tag. */
  nameRange: Range;
  /** Block (container) widget: its body contains `{@children}`, so it takes a `{/name}` closing tag. */
  block: boolean;
}
