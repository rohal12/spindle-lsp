import { afterEach, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { getCompletions } from '../../src/plugins/completions.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';
import { evaluate } from '../helpers/expression-oracle.js';

const uri = 'file:///story.tw';
const prefix = ':: StoryVariables\n$foo = "old"\n$foobar = "chosen"\n'
  + '$obj = {foo:"old", food:"chosen", "$food":"chosen", "first-name":"chosen", "fóod":"chosen"}\n'
  + ':: StoryTransients\n%count = 2\n%agent = {foo:"old", food:"chosen", "first-name":"chosen"}\n'
  + ':: Start\n{set _hello = 1}{set @local = 1}\n';
const workspaces: WorkspaceModel[] = [];
afterEach(() => workspaces.splice(0).forEach(ws => ws.dispose()));

function complete(marked: string, eol = '\n') {
  const index = marked.indexOf('¦');
  const text = (prefix + marked.replace('¦', '')).replaceAll('\n', eol);
  const doc = TextDocument.create(uri, 'twee', 1, text);
  const position = doc.positionAt((prefix + marked.slice(0, index)).replaceAll('\n', eol).length);
  const ws = new WorkspaceModel();
  workspaces.push(ws);
  ws.initialize(new Map([[uri, text]]));
  return { ws, doc, items: getCompletions(uri, position, undefined, ws) };
}

describe('tooling-owned completion edit spans (#232, #238)', () => {
  it.each([
    [String.raw`{print $fo¦\u006f}`, '$foobar', '{print $foobar}'],
    [String.raw`{print $fo¦\u{6f}}`, '$foobar', '{print $foobar}'],
    ['{print $fo¦o}', '$foobar', '{print $foobar}'],
    ['{print %co¦unt}', '%count', '{print %count}'],
    [String.raw`{print $obj.fo¦\u006f}`, 'food', '{print $obj.food}'],
    [String.raw`{print $obj.$fo¦\u006f}`, '$food', '{print $obj.$food}'],
    [String.raw`{print $obj.fó¦o}`, 'fóod', '{print $obj["fóod"]}'],
    [String.raw`{print $obj.fo¦\u{6f}}`, 'first-name', '{print $obj["first-name"]}'],
    [String.raw`{print %agent.fo¦\u006f}`, 'food', '{print %agent.food}'],
    [String.raw`{print $obj?.fo¦\u006f}`, 'first-name', '{print $obj?.["first-name"]}'],
  ])('applies the selected %s completion as %s', (marked, label, expected) => {
    const { ws, doc, items } = complete(marked);
    const item = items.find(item => item.label === label);
    expect(item?.textEdit).toBeDefined();
    const edited = TextDocument.applyEdits(doc, [item!.textEdit as never]);
    expect(edited).toBe(prefix + expected);
    ws.documents.update(uri, edited);
    expect(computeDiagnostics(uri, ws).filter(d => d.severity === 'error')).toEqual([]);
    const expression = ws.markup.get(uri)!.passages.at(-1)!.pieces.filter(piece => piece.kind === 'code').at(-1)!;
    expect(expression.kind).toBe('code');
    if (expression.kind === 'code') {
      expect(evaluate(expression.code, {
        foobar: 'chosen', obj: { food: 'chosen', $food: 'chosen', 'first-name': 'chosen', fóod: 'chosen' },
      }, {}, {}, { count: 2, agent: { food: 'chosen' } })).toBe(label === '%count' ? 2 : 'chosen');
    }
  });

  it.each(['\n', '\r\n', '\r'])('maps escaped member suffixes through encoded containers with %j line breaks', eol => {
    for (const [marked, expected, closing] of [
      [String.raw`{button "{print $obj.fo¦\\u006f}"}x{/button}`, String.raw`{button "{print $obj[\"first-name\"]}"}x{/button}`, ''],
      [String.raw`{button "{print $obj.fo¦\\u006f}`, String.raw`{button "{print $obj[\"first-name\"]}`, '"}x{/button}'],
      [String.raw`<span title='{button "{print $obj.fo¦\\u006f}`, String.raw`<span title='{button "{print $obj[\"first-name\"]}`, '"}x{/button}\'></span>'],
      [String.raw`[[{print $obj.fo¦\u006f}->Start]]`, '[[{print $obj["first-name"]}->Start]]', ''],
      [String.raw`<span title="{print $obj.fo¦\u006f}">x</span>`, '<span title="{print $obj["first-name"]}">x</span>', ''],
    ]) {
      const { ws, doc, items } = complete(marked, eol);
      const item = items.find(item => item.label === 'first-name');
      expect(item?.textEdit, marked).toBeDefined();
      const edited = TextDocument.applyEdits(doc, [item!.textEdit as never]);
      expect(edited).toBe(prefix.replaceAll('\n', eol) + expected);
      ws.documents.update(uri, edited + closing);
      expect(computeDiagnostics(uri, ws).filter(d => d.code === 'SP106' || d.code === 'SP200')).toEqual([]);
      const piece = ws.markup.get(uri)!.passages.at(-1)!.pieces.find(piece => piece.kind === 'code' && piece.code.includes('first-name'));
      expect(piece?.kind).toBe('code');
      if (piece?.kind === 'code') expect(evaluate(piece.code, { obj: { 'first-name': 'chosen' } })).toBe('chosen');
    }
  });

  it.each([
    '{print 5 %¦2}', '{print 5 %co¦unt}', '{print 5 %agent.fo¦o}',
    '{print ({foo_bar:3}).foo_¦bar}', '{print ({$name:3}).$na¦me}',
    '{print ({foo_bar:3}).foo_¦bar.field}', '{print foo$¦bar}',
  ])('suppresses variable edits at an operator or ordinary identifier in %s', marked => {
    expect(complete(marked).items).toEqual([]);
  });

  it.each([
    ['{print %¦count}', '%count', '{print %count}', 2],
    ['{print 5 % %¦count}', '%count', '{print 5 % %count}', 1],
    ['{print _¦hello}', '_hello', '{print _hello}', 7],
    ['{print @¦local}', '@local', '{print @local}', 9],
  ] as const)('keeps actual variable references executable in %s', (marked, label, expected, value) => {
    const { doc, items } = complete(marked);
    const item = items.find(item => item.label === label);
    expect(item?.textEdit).toBeDefined();
    const edited = TextDocument.applyEdits(doc, [item!.textEdit as never]);
    expect(edited).toBe(prefix + expected);
    expect(evaluate(expected.slice(7, -1), {}, { hello: 7 }, { local: 9 }, { count: 2 })).toBe(value);
  });
});
