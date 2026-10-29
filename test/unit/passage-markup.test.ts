import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';

function workspace(text: string, uri = 'file:///story.tw'): WorkspaceModel {
  const ws = new WorkspaceModel();
  ws.initialize(new Map([[uri, text]]));
  return ws;
}

const SOURCE = [
  ':: StoryVariables',
  '$gold = 5',
  ':: Start',
  'Gold: {$gold} {if $gold > 3}rich{else}poor{/if} [[Go->Next]]',
  ':: Next',
  '{goto "Start"}',
  '',
].join('\n');

describe('PassageMarkup (the tooling API through the workspace)', () => {
  it('reads tokens, pairing and pieces per passage', () => {
    const doc = workspace(SOURCE).markup.get('file:///story.tw')!;
    expect(doc.passages.map(p => p.passage.name)).toEqual(['StoryVariables', 'Start', 'Next']);

    const start = doc.passages[1];
    expect(start.isMarkup).toBe(true);
    expect(start.tokens.some(t => t.type === 'link')).toBe(true);
    expect(start.pairing.errors).toEqual([]);
    expect(start.pairing.nodes.some(n => n.token.type === 'macro' && n.token.name === 'if' && n.body?.close)).toBe(true);
    const names = start.pieces.filter(p => p.kind === 'passage').map(p => (p as { name: string }).name);
    expect(names).toEqual(['Next']);

    const next = doc.passages[2];
    expect(next.pieces.filter(p => p.kind === 'passage').map(p => (p as { name: string }).name)).toEqual(['Start']);
  });

  it('reads declarations of StoryVariables without evaluating them', () => {
    const doc = workspace(SOURCE).markup.get('file:///story.tw')!;
    const vars = doc.passages[0];
    expect(vars.isMarkup).toBe(false);
    expect(vars.tokens).toEqual([]);
    expect(vars.declarations.declarations.map(d => d.name)).toEqual(['gold']);
  });

  it('maps offsets into a CRLF document back to document positions', () => {
    const crlf = SOURCE.replace(/\n/g, '\r\n');
    const doc = workspace(crlf).markup.get('file:///story.tw')!;
    const start = doc.passages[1];
    expect(start.content.includes('\r')).toBe(false);
    const link = start.tokens.find(t => t.type === 'link')!;
    const range = start.range(link.start, link.end);
    expect(range.start.line).toBe(3);
    expect(crlf.slice(start.docOffset(link.start), start.docEnd(link.end))).toBe('[[Go->Next]]');
    expect(range.end.character - range.start.character).toBe('[[Go->Next]]'.length);
    expect(start.contentOffset(start.docOffset(link.start))).toBe(link.start);
  });

  it('is read again when the text changes', () => {
    const ws = workspace(SOURCE);
    const first = ws.markup.get('file:///story.tw')!;
    expect(ws.markup.get('file:///story.tw')).toBe(first);
    ws.documents.open('file:///story.tw', SOURCE + '{goto "Start"}\n');
    expect(ws.markup.get('file:///story.tw')).not.toBe(first);
    ws.dispose();
  });

  it('uses new header objects after reindexing unchanged text (#236)', () => {
    const uri = 'file:///story.tw';
    const ws = workspace(SOURCE);
    const first = ws.markup.get(uri)!;
    ws.passages.rebuild(uri, SOURCE);
    const fresh = ws.markup.get(uri)!;
    expect(fresh).not.toBe(first);
    expect(fresh.passages.map(p => p.passage)).toEqual(ws.passages.getPassagesInDocument(uri));
    expect(fresh.passages[1].passage).toBe(ws.passages.getPassagesInDocument(uri)[1]);
    expect(fresh.passages[1].passage).not.toBe(first.passages[1].passage);
    expect(ws.markup.get(uri)).toBe(fresh);
    ws.dispose();
  });

  it('reuses headerless markup and reads newly added headers (#236)', () => {
    const uri = 'file:///story.tw';
    const ws = workspace('prose without a header');
    const first = ws.markup.get(uri)!;
    expect(first.passages).toEqual([]);
    expect(ws.markup.get(uri)).toBe(first);
    ws.documents.update(uri, ':: Start\n[[Next]]');
    expect(ws.markup.get(uri)!.passages[0].passage.name).toBe('Start');
    ws.documents.update(uri, '');
    const empty = ws.markup.get(uri)!;
    expect(empty.text).toBe('');
    expect(empty.passages).toEqual([]);
    expect(ws.markup.get(uri)).toBe(empty);
    ws.dispose();
  });

  it('discards markup after closing and reopening identical text (#236)', () => {
    const uri = 'file:///story.tw';
    const ws = workspace(SOURCE);
    const first = ws.markup.get(uri)!;
    ws.documents.close(uri);
    expect(ws.markup.get(uri)).toBeUndefined();
    ws.documents.open(uri, SOURCE);
    const fresh = ws.markup.get(uri)!;
    expect(fresh).not.toBe(first);
    expect(fresh.passages[0].passage).toBe(ws.passages.getPassagesInDocument(uri)[0]);
    ws.dispose();
  });

  it('re-pairs unchanged text when macro metadata changes (#236)', () => {
    const uri = 'file:///story.tw';
    const ws = workspace(':: Start\n{panel}body{/panel}');
    const first = ws.markup.get(uri)!;
    expect(first.passages[0].pairing.nodes[0].body?.close).toBeUndefined();
    ws.macros.addMacro({ name: 'panel', block: true });
    const fresh = ws.markup.get(uri)!;
    expect(fresh).not.toBe(first);
    expect(fresh.passages[0].pairing.nodes[0].body?.close?.name).toBe('panel');
    ws.dispose();
  });

  it('re-pairs unchanged text when widget metadata changes (#236)', () => {
    const uri = 'file:///story.tw';
    const widgetUri = 'file:///widgets.tw';
    const ws = workspace(':: Start\n{panel}body{/panel}');
    ws.documents.open(widgetUri, ':: Widgets [widget]\n{widget "panel"}body{/widget}');
    const first = ws.markup.get(uri)!;
    expect(first.passages[0].pairing.nodes[0].body?.close).toBeUndefined();
    ws.documents.update(widgetUri, ':: Widgets [widget]\n{widget "panel"}{@children}{/widget}');
    const fresh = ws.markup.get(uri)!;
    expect(fresh).not.toBe(first);
    expect(fresh.passages[0].pairing.nodes[0].body?.close?.name).toBe('panel');
    ws.dispose();
  });
});
