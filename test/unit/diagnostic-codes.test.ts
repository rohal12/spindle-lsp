import { describe, it, expect } from 'vitest';
import { DiagnosticCode, getSeverity } from '../../src/core/diagnostic-codes.js';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

describe('diagnostic codes', () => {
  it('SP100 is warning severity', () => {
    expect(getSeverity(DiagnosticCode.UndefinedMacro)).toBe('warning');
  });

  it('SP101 is error severity', () => {
    expect(getSeverity(DiagnosticCode.MalformedContainer)).toBe('error');
  });

  it('SP102 is error severity, like the render failure it predicts', () => {
    expect(getSeverity(DiagnosticCode.MalformedElement)).toBe('error');
  });

  it('what Spindle refuses to start on is error severity', () => {
    expect(DiagnosticCode.UnclosedMarkup).toBe('SP105');
    expect(DiagnosticCode.CodeSyntaxError).toBe('SP106');
    expect(DiagnosticCode.UnquotedPassageName).toBe('SP113');
    expect(DiagnosticCode.ReservedVariableName).toBe('SP208');
    for (const code of [
      DiagnosticCode.IllegalClosingTag,
      DiagnosticCode.UnclosedMarkup,
      DiagnosticCode.CodeSyntaxError,
      DiagnosticCode.InvalidChildren,
      DiagnosticCode.ParameterTypeError,
      DiagnosticCode.UnquotedPassageName,
      DiagnosticCode.ReservedVariableName,
    ]) {
      expect(getSeverity(code), code).toBe('error');
    }
  });

  it('SP103 (macros in an attribute are text) and SP204 (null) are gone: Spindle evaluates and accepts them', () => {
    const codes: string[] = Object.values(DiagnosticCode);
    expect(codes).not.toContain('SP103');
    expect(codes).not.toContain('SP204');
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

  it('SP207 is error severity: Spindle will not start the story', () => {
    expect(DiagnosticCode.InvalidDeclaration).toBe('SP207');
    expect(getSeverity(DiagnosticCode.InvalidDeclaration)).toBe('error');
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

// Every kind of diagnostic the tooling API reports has a code (the kinds are those of `MarkupDiagnosticCode`
// and `VariableDiagnosticCode`, which it keeps stable). The content is the one its own tests use.
describe('the code of each kind of diagnostic Spindle reports', () => {
  const story = ':: StoryVariables\n$a = 1\n$s = "x"\n\n:: Other\nx\n\n:: Start\n';
  /** The codes reported for `content` in a passage of a story that declares `$a` (a number); `%t` is declared too when it mentions a transient. */
  const found = (content: string): string[] => {
    const transients = content.includes('%') ? ':: StoryTransients\n%t = 1\n\n' : '';
    const workspace = new WorkspaceModel();
    workspace.initialize(new Map([['file:///test.tw', transients + story + content]]));
    return computeDiagnostics('file:///test.tw', workspace).map(d => d.code);
  };

  it.each([
    ['unclosed-block', '{if $a}x', 'SP101'],
    ['unclosed-block (element)', '<div>x', 'SP102'],
    ['mismatched-closer', '{if $a}{for @i of [1]}{/if}{/for}', 'SP101'],
    ['mismatched-closer (element)', '<b><i>x</b></i>', 'SP102'],
    ['stray-closer (container)', 'x{/if}', 'SP101'],
    ['stray-closer (element)', 'x</i>', 'SP102'],
    ['stray-closer (not a container)', 'x{/set}', 'SP104'],
    ['misplaced-branch', '{else}', 'SP107'],
    ['invalid-closer', '{/ if}', 'SP104'],
    ['closer-with-arguments', '{if $a}{/if x}', 'SP104'],
    ['closer-with-selectors', '{if $a}{.a /if}', 'SP104'],
    ['unclosed-link', 'a [[b', 'SP105'],
    ['unclosed-expression', '{$a + ', 'SP105'],
    ['unclosed-macro', '{if $a', 'SP105'],
    ['unclosed-tag', '<div', 'SP102'],
    ['unexpected-character', '<div "x">', 'SP102'],
    ['unclosed-attribute', '<a title="x>', 'SP102'],
    ['unknown-macro', '{sett $a = 1}', 'SP100'],
    ['argument-error', '{link Go}x{/link}', 'SP109'],
    ['code-syntax', '{$a b}', 'SP106'],
    ['unknown-passage', '[[Go->Nowhere]]', 'SP300'],
    ['unquoted-passage-name', '{goto Other}', 'SP113'],
    ['undeclared-variable', '{$nope}', 'SP200'],
    ['undeclared-transient (with StoryTransients)', '{%nope}', 'SP203'],
    ['primitive-field', '{$a.b}', 'SP201'],
    ['reserved-name', '{$__proto__}', 'SP208'],
  ])('%s: %s -> %s', (_kind, content, code) => {
    expect(found(content)).toContain(code);
  });
});
