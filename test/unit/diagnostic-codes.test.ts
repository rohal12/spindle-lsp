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

  it('all codes have SP prefix format', () => {
    for (const val of Object.values(DiagnosticCode)) {
      if (typeof val === 'string') {
        expect(val).toMatch(/^SP\d+$/);
      }
    }
  });
});
