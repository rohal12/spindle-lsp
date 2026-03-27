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

export interface DeclaredVariable {
  name: string;
  sigil: '$' | '_' | '@' | '%';
  fields?: string[];
  declarationUri?: string;
  declarationRange?: Range;
}

export interface WidgetDef {
  name: string;
  params: string[];
  uri: string;
  range: Range;
}
