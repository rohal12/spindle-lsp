import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Position } from '../../src/core/types.js';
import { computeRename } from '../../src/plugins/rename.js';
import { getDefinition } from '../../src/plugins/definition.js';
import { findPassageReferences, findReferences } from '../../src/plugins/references.js';
import { computeDiagnostics } from '../../src/plugins/diagnostics.js';

const URI = 'file:///test.tw';

function createWorkspace(content: string): WorkspaceModel {
  const ws = new WorkspaceModel();
  ws.initialize(new Map([[URI, content]]));
  return ws;
}

/** Position of the `occurrence`-th (0-based) match of `needle` in `content`. */
function positionOf(content: string, needle: string, occurrence = 0): Position {
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) {
    offset = content.indexOf(needle, offset + 1);
    if (offset === -1) throw new Error(`"${needle}" #${occurrence} not found`);
  }
  const before = content.slice(0, offset).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

/** The text each reference range covers. */
function referencedTexts(content: string, name: string): string[] {
  const doc = TextDocument.create(URI, 'twee3', 1, content);
  return findPassageReferences(name, createWorkspace(content), false).map(r => doc.getText(r.range));
}

function sp300Messages(content: string): string[] {
  return computeDiagnostics(URI, createWorkspace(content))
    .filter(d => d.code === 'SP300')
    .map(d => d.message);
}

/** Rename the passage whose header contains `name` and return the resulting text. */
function renamePassage(content: string, name: string, newName: string): string {
  const ws = createWorkspace(content);
  const header = positionOf(content, `:: ${name}`);
  const edits = computeRename(URI, { line: header.line, character: header.character + 4 }, newName, ws);
  const doc = TextDocument.create(URI, 'twee3', 1, content);
  return TextDocument.applyEdits(doc, edits.get(URI) ?? []);
}

describe('passage rename', () => {
  it('keeps the header marker, tags and metadata', () => {
    const content = ':: Target [nobr] {"position":"100,100"}\nText\n:: Start\n[[Target]]';
    expect(renamePassage(content, 'Target', 'Renamed')).toBe(
      ':: Renamed [nobr] {"position":"100,100"}\nText\n:: Start\n[[Renamed]]',
    );
  });

  it('keeps a header without tags intact', () => {
    const content = ':: Target\nText\n:: Start\n[[Target]]';
    expect(renamePassage(content, 'Target', 'Renamed')).toBe(
      ':: Renamed\nText\n:: Start\n[[Renamed]]',
    );
  });

  it('edits the link target and keeps display text equal to it', () => {
    const content = ':: Start\n[[Target|Target]] [[Target page|Target]]\n:: Target\nText';
    expect(renamePassage(content, 'Target', 'Renamed')).toBe(
      ':: Start\n[[Target|Renamed]] [[Target page|Renamed]]\n:: Renamed\nText',
    );
  });
});

describe('arrow link forms', () => {
  const content = ':: Start\n[[go->Target]]\n[[Target<-go]]\n:: Target\nText';

  it('reports no SP300 when the arrow target exists', () => {
    expect(sp300Messages(content)).toEqual([]);
  });

  it('reports SP300 with the target name when it is missing', () => {
    expect(sp300Messages(':: Start\n[[go->Nowhere]]\n[[Gone<-go]]')).toEqual([
      'Passage "Nowhere" not found in workspace',
      'Passage "Gone" not found in workspace',
    ]);
  });

  it('jumps to the target from either arrow form', () => {
    for (const pos of [positionOf(content, 'Target'), positionOf(content, 'Target', 1)]) {
      const result = getDefinition(URI, { line: pos.line, character: pos.character + 1 }, createWorkspace(content));
      expect(result?.range.start.line).toBe(3);
    }
  });

  it('lists both arrow links as references to the target', () => {
    expect(referencedTexts(content, 'Target')).toEqual(['Target', 'Target']);
    const pos = positionOf(content, 'Target');
    const refs = findReferences(URI, { line: pos.line, character: pos.character + 1 }, createWorkspace(content), false);
    expect(refs.map(r => r.range.start.line)).toEqual([1, 2]);
  });

  it('renames only the target of each arrow link', () => {
    expect(renamePassage(content, 'Target', 'Renamed')).toBe(
      ':: Start\n[[go->Renamed]]\n[[Renamed<-go]]\n:: Renamed\nText',
    );
  });
});

describe('macro passage references', () => {
  const content = [
    ':: Start',
    "{goto 'Target'}",
    '{goto Target}',
    '{include Target}',
    '{include "Target" inline}',
    "{include inline 'Target'}",
    '{.cls#id goto "Target"}',
    '{#box include "Target"}',
    '{link "Target" "Target"}{/link}',
    "{link 'Go to Target' 'Target'}{/link}",
    ':: Target',
    'Text',
  ].join('\n');

  it('finds every literal goto, include and link target', () => {
    expect(referencedTexts(content, 'Target')).toEqual(Array(9).fill('Target'));
  });

  it('renames only the targets, keeping labels and the inline keyword', () => {
    expect(renamePassage(content, 'Target', 'Renamed')).toBe([
      ':: Start',
      "{goto 'Renamed'}",
      '{goto Renamed}',
      '{include Renamed}',
      '{include "Renamed" inline}',
      "{include inline 'Renamed'}",
      '{.cls#id goto "Renamed"}',
      '{#box include "Renamed"}',
      '{link "Target" "Renamed"}{/link}',
      "{link 'Go to Target' 'Renamed'}{/link}",
      ':: Renamed',
      'Text',
    ].join('\n'));
  });

  it('jumps to the passage from each target', () => {
    const ws = createWorkspace(content);
    const lines = content.split('\n');
    for (let line = 1; line <= 9; line++) {
      const character = lines[line].lastIndexOf('Target') + 1;
      expect(getDefinition(URI, { line, character }, ws)?.range.start.line, lines[line]).toBe(10);
    }
  });

  it('jumps from a {link} target, not from a label naming another passage', () => {
    const ws = createWorkspace(':: Start\n{link "Elsewhere" "Target"}{/link}\n:: Target\nText\n:: Elsewhere\nText');
    expect(getDefinition(URI, { line: 1, character: 8 }, ws)).toBeNull();
    expect(getDefinition(URI, { line: 1, character: 21 }, ws)?.range.start.line).toBe(2);
  });

  it('finds references from the cursor on a macro target', () => {
    const pos = positionOf(content, "'Target'");
    const refs = findReferences(URI, { line: pos.line, character: pos.character + 2 }, createWorkspace(content), true);
    expect(refs).toHaveLength(10);
  });

  it('skips dynamic targets and macros that do not navigate', () => {
    const dynamic = [
      ':: Start',
      '{goto $dest}',
      '{include _part}',
      '{goto "Tar" + "get"}',
      '{include "Target {$n}"}',
      '{link "Go" $dest}{/link}',
      '{link $label "Target"}{/link}',
      '{button "Target" "Target"}{/button}',
      ':: Target',
      'Text',
    ].join('\n');
    expect(referencedTexts(dynamic, 'Target')).toEqual([]);
  });
});
