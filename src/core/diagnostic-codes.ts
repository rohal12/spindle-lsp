export const DiagnosticCode = {
  UndefinedMacro: 'SP100',
  MalformedContainer: 'SP101',
  IllegalClosingTag: 'SP104',
  InvalidChildren: 'SP107',
  ExpectedNoArguments: 'SP108',
  ParameterTypeError: 'SP109',
  ParameterWarning: 'SP110',
  TooManyArguments: 'SP111',
  ArgumentParsingWarning: 'SP112',
  ChildMaxExceeded: 'SP114',
  ChildMinNotMet: 'SP115',
  UndeclaredVariable: 'SP200',
  UndeclaredField: 'SP201',
  NoStoryVariables: 'SP202',
  BrokenPassageLink: 'SP300',
  WidgetArgCountMismatch: 'SP301',
  DeadEndPassage: 'SP400',
  UnreachablePassage: 'SP401',
} as const;

export type DiagnosticCodeValue = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

type Severity = 'error' | 'warning' | 'info' | 'hint';

const severityMap: Record<DiagnosticCodeValue, Severity> = {
  SP100: 'warning',
  SP101: 'error',
  SP104: 'error',
  SP107: 'error',
  SP108: 'error',
  SP109: 'error',
  SP110: 'warning',
  SP111: 'error',
  SP112: 'warning',
  SP114: 'error',
  SP115: 'error',
  SP200: 'warning',
  SP201: 'warning',
  SP202: 'info',
  SP300: 'warning',
  SP301: 'warning',
  SP400: 'hint',
  SP401: 'hint',
};

export function getSeverity(code: DiagnosticCodeValue): Severity {
  return severityMap[code];
}
