import { describe, it, expect } from 'vitest';
import { DiagnosticCode, getSeverity } from '../../src/core/diagnostic-codes.js';

describe('diagnostic codes', () => {
  it('SP100 is warning severity', () => {
    expect(getSeverity(DiagnosticCode.UndefinedMacro)).toBe('warning');
  });

  it('SP101 is error severity', () => {
    expect(getSeverity(DiagnosticCode.MalformedContainer)).toBe('error');
  });

  it('SP400 is hint severity', () => {
    expect(getSeverity(DiagnosticCode.DeadEndPassage)).toBe('hint');
  });

  it('SP202 is info severity', () => {
    expect(getSeverity(DiagnosticCode.NoStoryVariables)).toBe('info');
  });

  it('SP205, SP206 and SP302 are warning severity', () => {
    expect(getSeverity(DiagnosticCode.TemporaryAssignedInLoop)).toBe('warning');
    expect(getSeverity(DiagnosticCode.ArrayMemberAccess)).toBe('warning');
    expect(getSeverity(DiagnosticCode.IncludeWidgetPassage)).toBe('warning');
  });

  it('SP201 is error severity, like the startup failure it predicts', () => {
    expect(getSeverity(DiagnosticCode.PrimitiveFieldAccess)).toBe('error');
  });

  it('SP303 is hint severity', () => {
    expect(getSeverity(DiagnosticCode.UnusedWidget)).toBe('hint');
  });

  it('all codes have SP prefix format', () => {
    for (const val of Object.values(DiagnosticCode)) {
      if (typeof val === 'string') {
        expect(val).toMatch(/^SP\d+$/);
      }
    }
  });
});
