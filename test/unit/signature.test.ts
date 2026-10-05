import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { Parameters } from '../../src/core/parsing/parameter-validator.js';
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
  /** `version` is the Spindle the story declares (StoryData `format-version`); 0.45.1 when omitted. */
  function help(content: string, version?: string) {
    const ws = createWorkspace(
      {
        name: 'widgets.tw',
        content: ':: MyWidgets [widget]\n{widget "counter" @count @label}\n{@count} {@label}\n{/widget}'
          + (version ? `\n:: StoryData\n{"format": "Spindle", "format-version": "${version}"}` : ''),
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
    expect(help(':: Start\n{counter {a: 1}, ', '0.51.3')?.activeParameter).toBe(1);
  });

  it('looks past braces inside strings from Spindle 0.50.1, and counts them before', () => {
    // From 0.50.1 the tokenizer skips the strings, so `{counter` is still open;
    // before it the `}` in the string closes it and there is no macro to help with.
    for (const version of ['0.50.1', '0.51.3']) {
      expect(help(':: Start\n{counter "x}", ', version)?.activeParameter, version).toBe(1);
      expect(help(':: Start\n{counter `${1}}`, ', version)?.activeParameter, version).toBe(1);
    }
    for (const version of [undefined, '0.43.0', '0.45.1', '0.50.0']) {
      expect(help(':: Start\n{counter "x}", ', version), String(version)).toBeNull();
    }
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
    ['textbox', '$name ', 1, ['variable', '[placeholder]']],
    ['radiobutton', '$name "yes" ', 2, ['variable', 'value', '[label]']],
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
      ['[label]', '[more]'],
      ['label'],
    ]);
    expect(result.signatures.map(s => s.label)).toEqual(['{option [label] [more]}', '{option label}']);
    expect(result.activeSignature).toBe(0);
    expect(result.activeParameter).toBe(1);
  });

  it('H79-repetition: a repeated position stays active for further arguments', () => {
    const result = help('{set $a to 1, $b to 2, $c ')!;
    const sig = result.signatures[result.activeSignature];
    expect(sig.parameters.map(p => p.label)).toEqual(['...assignment']);
    expect(result.activeParameter).toBe(0);
  });
});

describe('N-sig: active signature follows typed arguments; parameters are named', () => {
  const uri = 'file:///story.tw';
  type Config = Record<string, { parameters: string[]; parameterDocs?: Array<{ name: string; documentation?: string }> }>;
  function helpWith(body: string, macros: Config = {}) {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([[uri, `:: StoryVariables\n$name = ""\n:: Start\n${body}`]]));
    ws.macros.loadConfig(macros);
    return getSignatureHelp(uri, { line: 3, character: body.length }, ws)!;
  }
  const alt: Config = {
    pick: {
      parameters: ['bool &+ text', "number &+ 'a'", 'string &+ number'],
      parameterDocs: [{ name: 'flag' }, { name: 'second' }],
    },
  };
  const names = (r: ReturnType<typeof helpWith>) => r.signatures[r.activeSignature].parameters.map(p => p.label);

  it('N-sig-type-1: a boolean first argument selects the boolean alternative', () => {
    const r = helpWith('{pick true ', alt);
    expect(r.signatures).toHaveLength(3);
    expect(r.activeSignature).toBe(0);
    expect(r.activeParameter).toBe(1);
  });

  it('N-sig-type-2: a number first argument skips the boolean alternative', () => {
    const r = helpWith('{pick 5 ', alt);
    expect(names(r)).toEqual(['flag: number', "second: 'a'"]);
    expect(r.activeSignature).toBe(1);
    expect(r.activeParameter).toBe(1);
  });

  it('N-sig-type-3: a string first argument selects the string alternative', () => {
    const r = helpWith('{pick "x" ', alt);
    expect(names(r)).toEqual(['flag: string', 'second: number']);
    expect(r.activeSignature).toBe(2);
    const s = helpWith('{pick "x" 5', { pick: { parameters: ['number &+ text', 'string &+ number'] } });
    expect(s.activeSignature).toBe(1);
  });

  it('N-sig-type-4: a variable fits every alternative, so the first with the position wins', () => {
    expect(helpWith('{pick $name ', alt).activeSignature).toBe(0);
  });

  it('N-sig-type-5: the argument still being typed does not narrow the choice', () => {
    expect(helpWith('{pick 5', alt).activeSignature).toBe(0);
    expect(helpWith('{pick "x', alt).activeSignature).toBe(0);
  });

  it('N-sig-type-6: a typed literal in a later position narrows to the literal alternative', () => {
    const cfg: Config = { pick: { parameters: ["number &+ 'a' &+ text", 'number &+ text &+ number'] } };
    expect(helpWith("{pick 1 'a' ", cfg).activeSignature).toBe(0);
    expect(helpWith('{pick 1 "b" ', cfg).activeSignature).toBe(1);
    expect(helpWith('{pick 1 "b" ', cfg).activeParameter).toBe(2);
  });

  it('N-sig-type-7: when nothing accepts the prefix, a signature with the position still wins', () => {
    const r = helpWith('{pick null ', alt);
    expect(r.activeParameter).toBe(1);
    expect(r.signatures[r.activeSignature].parameters.length).toBeGreaterThan(1);
  });

  it('N-sig-type-8: built-in textbox/radiobutton keep their single alternative', () => {
    expect(helpWith('{textbox $name "p" ').activeSignature).toBe(0);
    expect(helpWith('{radiobutton $name "a" "b" ').activeSignature).toBe(0);
  });

  it('N-sig-type-9: built-in option alternatives: two arguments need the two-position signature', () => {
    const r = helpWith('{listbox $name}{option "a" ');
    expect(r.activeSignature).toBe(0);
    expect(r.signatures[r.activeSignature].label).toBe('{option [label] [more]}');
  });

  it('N-sig-type-10: built-in link/dialog/set: typed prefix keeps the right active parameter', () => {
    expect(helpWith('{link "go" ').activeParameter).toBe(1);
    expect(helpWith('{dialog "open" ').signatures[0].parameters.map(p => p.label)).toEqual(['label', '[noclose]']);
    expect(helpWith('{set $a to 1, $b to 2 ').activeParameter).toBe(0);
  });

  it('N-sig-name-1: parameters carry descriptive names and documentation, not slot type names', () => {
    const r = helpWith('{textbox $name ');
    const [variable, placeholder] = r.signatures[0].parameters;
    expect(variable.label).toBe('variable');
    expect(variable.documentation).toContain('Story variable');
    expect(variable.documentation).toContain('Type: receiver');
    expect(placeholder.label).toBe('[placeholder]');
    expect(r.signatures[0].label).toBe('{textbox variable [placeholder]}');
  });

  it('N-sig-name-2: every built-in macro with parameters names and documents every position', () => {
    const ws = new WorkspaceModel();
    ws.initialize(new Map([[uri, ':: Start\n']]));
    const unnamed: string[] = [];
    for (const macro of ws.macros.getAllMacros()) {
      if (!macro.parameters?.some(p => p !== '')) continue;
      const docs = macro.parameterDocs ?? [];
      const longest = Math.max(
        ...macro.parameters.map(p => Math.max(0, ...new Parameters([p]).describe().map(seq => seq.length))),
      );
      if (docs.length < longest || docs.some(d => !d.name || !d.documentation)) unnamed.push(macro.name);
    }
    expect(unnamed).toEqual([]);
  });

  it('N-sig-name-3: user config parameterDocs override the names; absent docs fall back to the type', () => {
    const r = helpWith('{mine 1 ', { mine: { parameters: ['number &+ text'], parameterDocs: [{ name: 'count', documentation: 'How many.' }] } });
    expect(r.signatures[0].parameters.map(p => p.label)).toEqual(['count', 'text']);
    expect(r.signatures[0].parameters[0].documentation).toContain('How many.');
  });

  it('N-sig-wire: LSP parameter labels are offsets that slice the signature label', async () => {
    const { signaturePlugin } = await import('../../src/plugins/signature.js');
    let handler: ((p: unknown) => any) | undefined;
    const ws = new WorkspaceModel();
    const body = '{textbox $name ';
    ws.initialize(new Map([[uri, `:: Start\n${body}`]]));
    signaturePlugin.initialize!({ connection: { onSignatureHelp: (h: any) => { handler = h; } }, workspace: ws } as any);
    const out = handler!({ textDocument: { uri }, position: { line: 1, character: body.length } });
    const sig = out.signatures[0];
    expect(sig.parameters.map((p: any) => sig.label.slice(p.label[0], p.label[1]))).toEqual(['variable', '[placeholder]']);
    expect(sig.parameters[0].documentation).toContain('Story variable');
  });
});
