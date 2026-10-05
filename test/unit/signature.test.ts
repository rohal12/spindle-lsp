import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { getSignatureHelp } from '../../src/plugins/signature.js';

function createWorkspace(...files: Array<{ name: string; content: string }>): WorkspaceModel {
  const ws = new WorkspaceModel();
  const contents = new Map<string, string>();
  for (const f of files) {
    contents.set(`file:///${f.name}`, f.content);
  }
  ws.initialize(contents);
  return ws;
}

describe('getSignatureHelp', () => {
  it('returns signature help for a known macro with parameters', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\n{set ',
    });
    const result = getSignatureHelp('file:///test.tw', { line: 1, character: 5 }, ws);
    // 'set' has parameters defined in supplements
    if (result) {
      expect(result.signatures.length).toBeGreaterThan(0);
      expect(result.signatures[0].label).toContain('set');
    }
  });

  it('returns signature help for a widget with params', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "greeting" @name}\nHello {@name}!\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{greeting ',
      },
    );
    const result = getSignatureHelp('file:///test.tw', { line: 1, character: 10 }, ws);
    expect(result).not.toBeNull();
    expect(result!.signatures[0].label).toContain('greeting');
    expect(result!.signatures[0].parameters).toHaveLength(1);
    expect(result!.signatures[0].parameters[0].label).toBe('@name');
  });

  it('returns null when not inside macro arguments', () => {
    const ws = createWorkspace({
      name: 'test.tw',
      content: ':: Start\nPlain text here',
    });
    const result = getSignatureHelp('file:///test.tw', { line: 1, character: 5 }, ws);
    expect(result).toBeNull();
  });

  it('computes active parameter based on args before cursor', () => {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "counter" @count @label}\n{@count} {@label}\n{/widget}',
      },
      {
        name: 'test.tw',
        content: ':: Start\n{counter 5 ',
      },
    );
    const result = getSignatureHelp('file:///test.tw', { line: 1, character: 11 }, ws);
    expect(result).not.toBeNull();
    // After "5 " we have 1 arg already, so activeParameter should be 1
    expect(result!.activeParameter).toBe(1);
  });
});

describe('getSignatureHelp for widget arguments', () => {
  function activeParameter(before: string): number | undefined {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "counter" @count @label}\n{@count} {@label}\n{/widget}',
      },
      { name: 'test.tw', content: `:: Start\n{counter ${before}` },
    );
    return getSignatureHelp('file:///test.tw', { line: 1, character: 9 + before.length }, ws)?.activeParameter;
  }

  it('stays on an argument whose expression is still open', () => {
    expect(activeParameter('(1 + ')).toBe(0);
    expect(activeParameter('[1, ')).toBe(0);
    expect(activeParameter('$a + ')).toBe(0);
  });

  it('moves to the next argument after a top-level separator', () => {
    expect(activeParameter('(1 + 2) ')).toBe(1);
    expect(activeParameter('[1, 2], ')).toBe(1);
    expect(activeParameter('$a + 1, ')).toBe(1);
  });
});

describe('getSignatureHelp finds the enclosing macro', () => {
  function help(content: string) {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "counter" @count @label}\n{@count} {@label}\n{/widget}',
      },
      { name: 'test.tw', content },
    );
    // The cursor sits at the end of the document
    const lines = content.split('\n');
    const position = { line: lines.length - 1, character: lines[lines.length - 1].length };
    return getSignatureHelp('file:///test.tw', position, ws);
  }

  it('looks past braces inside arguments', () => {
    expect(help(':: Start\n{counter {a: 1}, ')?.activeParameter).toBe(1);
    expect(help(':: Start\n{counter "x}", ')?.activeParameter).toBe(1);
    expect(help(':: Start\n{counter `${1}}`, ')?.activeParameter).toBe(1);
  });

  it('follows arguments across lines', () => {
    const result = help(':: Start\n{counter {\n  a: 1\n}, ');
    expect(result?.signatures[0].label).toContain('counter');
    expect(result?.activeParameter).toBe(1);
  });

  it('returns null after the macro has closed', () => {
    expect(help(':: Start\n{counter {a: 1}} after ')).toBeNull();
    expect(help(':: Start\n{counter "}"} after ')).toBeNull();
  });

  it('does not reach into the previous passage', () => {
    expect(help(':: A\n{counter 5\n:: B\ntext ')).toBeNull();
  });

  it('reads the macro name after CSS selectors (#58)', () => {
    expect(help(':: Start\n{.cls#id counter 5, ')?.activeParameter).toBe(1);
  });

  it('does not take the end of a class name as a macro (#58)', () => {
    // {.my-counter $x …} is a variable display, not a {counter} call
    expect(help(':: Start\n{.my-counter $x + ')).toBeNull();
  });

  it('ignores a macro name after selectors Spindle does not accept (#58)', () => {
    // No whitespace between selectors, one space before the name
    expect(help(':: Start\n{.red .bold counter 5, ')).toBeNull();
    expect(help(':: Start\n{.red  counter 5, ')).toBeNull();
  });
});

describe('H79: signature schema and active argument (#79)', () => {
  const uri = 'file:///story.tw';
  function help(body: string) {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([[uri, `:: StoryVariables\n$name = ""\n:: Start\n${body}`]]));
    return getSignatureHelp(uri, { line: 3, character: body.length }, ws);
  }
  function active(body: string) {
    const result = help(body)!;
    return { result, sig: result.signatures[result.activeSignature] };
  }

  for (const [macro, args, activeIndex, labels] of [
    ['textbox', '$name ', 1, ['receiver', '[text]']],
    ['radiobutton', '$name "yes" ', 2, ['receiver', 'text', '[text]']],
  ] as const) {
    it(`H79-${macro}: schema describes each active argument`, () => {
      const { result, sig } = active(`{${macro} ${args}`);
      expect(result.activeParameter).toBe(activeIndex);
      expect(sig.parameters.map(p => p.label)).toEqual(labels);
      expect(sig.parameters.length).toBeGreaterThan(result.activeParameter);
    });
  }

  it('H79-partial: typing the first receiver keeps parameter zero active', () => {
    expect(help('{textbox $na')?.activeParameter).toBe(0);
    expect(help('{textbox $name')?.activeParameter).toBe(0);
    expect(help('{textbox $name ')?.activeParameter).toBe(1);
    expect(help('{textbox $name "pla')?.activeParameter).toBe(1);
    expect(help('{radiobutton $name "ye')?.activeParameter).toBe(1);
    expect(help('{radiobutton $name "yes"')?.activeParameter).toBe(1);
  });

  it('H79-alternation: each schema variant is a signature and the active one has the argument', () => {
    const ws = new WorkspaceModel();
    const body = '{listbox $x}{option "a" ';
    ws.initialize(new Map([[uri, `:: Start\n${body}`]]));
    const result = getSignatureHelp(uri, { line: 1, character: body.length }, ws)!;
    expect(result.signatures.map(s => s.parameters.map(p => p.label))).toEqual([
      ['[text]', '[text]'],
      ['text'],
    ]);
    expect(result.signatures.map(s => s.label)).toEqual(['{option [text] [text]}', '{option text}']);
    expect(result.activeSignature).toBe(0);
    expect(result.activeParameter).toBe(1);
  });

  it('H79-repetition: a repeated position stays active for further arguments', () => {
    const result = help('{set $a to 1, $b to 2, $c ')!;
    const sig = result.signatures[result.activeSignature];
    expect(sig.parameters.map(p => p.label)).toEqual(['...text']);
    expect(result.activeParameter).toBe(0);
  });
});
