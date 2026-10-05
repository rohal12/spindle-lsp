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
