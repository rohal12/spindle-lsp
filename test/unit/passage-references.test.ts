import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import type { Position } from '../../src/core/types.js';
import { computeRename } from '../../src/plugins/rename.js';

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
