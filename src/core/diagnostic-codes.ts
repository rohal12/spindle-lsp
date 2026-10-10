import type { Diagnostic, Position, Range } from './types.js';

/**
 * Where a diagnostic comes from. Most are Spindle's own checks, which the
 * tooling API reports (`validateStoryMarkup`, `validateVariableReferences`),
 * mapped to a stable SP code; the others are checks of the language server.
 */
export const DiagnosticCode = {
  /** The Spindle the project targets is older than the oldest one supported. */
  UnsupportedSpindleVersion: 'SP001',
  /** `unknown-macro`: a macro that is none of the built-in, configured or defined ones. */
  UndefinedMacro: 'SP100',
  /** `unclosed-block`, `mismatched-closer`, `stray-closer` of a macro. */
  MalformedContainer: 'SP101',
  /** Tags of an HTML element Spindle cannot read or pair. */
  MalformedElement: 'SP102',
  /** A closing tag that closes no macro (`{/set}`), or is malformed (`{/}`, `{/if x}`). */
  IllegalClosingTag: 'SP104',
  /** `unclosed-link`, `unclosed-expression`, `unclosed-macro`: a `[[`, `{$` or `{name` that is never ended. */
  UnclosedMarkup: 'SP105',
  /** `code-syntax`: JavaScript that does not parse. */
  CodeSyntaxError: 'SP106',
  /** `misplaced-branch` (`{else}` outside `{if}`), and a macro outside the parents it needs. */
  InvalidChildren: 'SP107',
  /** A configured parameter schema rejects the arguments (macros Spindle declares nothing for). */
  ExpectedNoArguments: 'SP108',
  /** `argument-error`: arguments that do not have their parameters' forms. */
  ParameterTypeError: 'SP109',
  ParameterWarning: 'SP110',
  TooManyArguments: 'SP111',
  /** `unquoted-passage-name`: `{goto Kitchen}`, which throws a ReferenceError. */
  UnquotedPassageName: 'SP113',
  ChildMaxExceeded: 'SP114',
  ChildMinNotMet: 'SP115',
  /** `undeclared-variable`. */
  UndeclaredVariable: 'SP200',
  /** `primitive-field`: a field of a number, string or boolean. */
  PrimitiveFieldAccess: 'SP201',
  NoStoryVariables: 'SP202',
  /** `undeclared-transient`. */
  UndeclaredTransient: 'SP203',
  TemporaryAssignedInLoop: 'SP205',
  ArrayMemberAccess: 'SP206',
  InvalidDeclaration: 'SP207',
  /** `reserved-name`: a variable named `__proto__`. */
  ReservedVariableName: 'SP208',
  /** `unknown-passage`. */
  BrokenPassageLink: 'SP300',
  WidgetArgCountMismatch: 'SP301',
  IncludeWidgetPassage: 'SP302',
  UnusedWidget: 'SP303',
  LinkRuntimeMismatch: 'SP304',
  LiteralLinkInterpolation: 'SP305',
  DeadEndPassage: 'SP400',
  UnreachablePassage: 'SP401',
  LineTooLong: 'SP500',
} as const;

export type DiagnosticCodeValue = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

type Severity = 'error' | 'warning' | 'info' | 'hint';

const severityMap: Record<DiagnosticCodeValue, Severity> = {
  SP001: 'warning',
  SP100: 'warning',
  SP101: 'error',
  SP102: 'error',
  SP104: 'error',
  SP105: 'error',
  SP106: 'error',
  SP107: 'error',
  SP108: 'error',
  SP109: 'error',
  SP110: 'warning',
  SP111: 'error',
  SP113: 'error',
  SP114: 'error',
  SP115: 'error',
  SP200: 'error',
  SP201: 'error',
  SP202: 'info',
  SP203: 'warning',
  SP205: 'warning',
  SP206: 'warning',
  SP207: 'error',
  SP208: 'error',
  SP300: 'warning',
  SP301: 'warning',
  SP302: 'warning',
  SP303: 'hint',
  SP304: 'warning',
  SP305: 'warning',
  SP400: 'hint',
  SP401: 'hint',
  SP500: 'warning',
};

export function getSeverity(code: DiagnosticCodeValue): Severity {
  return severityMap[code];
}

/**
 * What a quick fix needs to know about a diagnostic, beyond its range and
 * message. It travels in the diagnostic's `data` (the LSP returns it with a
 * code action request).
 */
export type DiagnosticData =
  /** `unknown-macro`: the name as written (`nameRange`) and the closest known macros. */
  | { kind: 'unknown-macro'; name: string; suggestions: string[]; nameRange: Range }
  /** `unknown-passage`: the name, the macro it is the argument of (`link` for `[[…]]`) and the closest passages. */
  | { kind: 'unknown-passage'; name: string; macro: string; suggestions: string[] }
  /** `unquoted-passage-name`: the bare word, written without quotes. */
  | { kind: 'unquoted-passage-name'; name: string; macro: string }
  /** `unclosed-block`: the closing tag that is missing, and where the passage ends. */
  | { kind: 'unclosed-block'; closer: string; at: Position }
  /** `undeclared-variable`, `undeclared-transient`. */
  | { kind: 'undeclared-variable'; name: string; sigil: '$' | '%' };

/** A diagnostic of this language server. */
export interface SpindleDiagnostic extends Diagnostic {
  data?: DiagnosticData;
}
