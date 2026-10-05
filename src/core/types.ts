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

export interface DeclaredVariable {
  name: string;
  sigil: '$' | '_' | '@' | '%';
  fields?: string[];
  /** Type of the default value, set only when the default is a single literal. */
  type?: VariableValueType;
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
}
