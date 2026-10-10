import { describe, it, expect } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { documentPassageRefs } from '../../src/core/markup/passage-refs.js';

const uri = 'file:///story.tw';

/** The bracket links of a passage body: the passage name each one targets, and the range of that name. */
function parseLinks(text: string, lineOffset: number = 0) {
  const model = new WorkspaceModel();
  model.initialize(new Map([[uri, `:: P\n${text}`]]));
  // the header is line 0, so the body starts on line 1
  return documentPassageRefs(model.markup.get(uri)!)
    .filter(ref => ref.form === 'bracket')
    .map(ref => ({
      name: ref.name,
      range: {
        start: { line: ref.range.start.line - 1 + lineOffset, character: ref.range.start.character },
        end: { line: ref.range.end.line - 1 + lineOffset, character: ref.range.end.character },
      },
    }));
}

describe('bracket links', () => {
  it('extracts [[PassageName]]', () => {
    const refs = parseLinks('[[PassageName]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('PassageName');
  });

  it('extracts [[Display|Target]]', () => {
    const refs = parseLinks('[[Display Text|Target]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Target');
  });

  it('extracts multiple links', () => {
    const refs = parseLinks('Go to [[Room A]] or [[Room B]]');
    expect(refs).toHaveLength(2);
    expect(refs[0].name).toBe('Room A');
    expect(refs[1].name).toBe('Room B');
  });

  it('returns empty for no links', () => {
    expect(parseLinks('plain text')).toHaveLength(0);
  });

  it('handles link on specific line', () => {
    const refs = parseLinks('[[Target]]', 5);
    expect(refs[0].range.start.line).toBe(5);
  });

  it('extracts from multi-line text', () => {
    const refs = parseLinks('line 0\n[[A]]\nline 2\n[[B]]');
    expect(refs).toHaveLength(2);
    expect(refs[0].range.start.line).toBe(1);
    expect(refs[1].range.start.line).toBe(3);
  });

  it('locates the target, not display text equal to it', () => {
    const refs = parseLinks('[[Target|Target]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].range.start.character).toBe(9);
    expect(refs[0].range.end.character).toBe(15);
  });

  it('locates the target when the display text contains it', () => {
    const refs = parseLinks('[[Go to Target now| Target ]]');
    expect(refs[0].name).toBe('Target');
    expect(refs[0].range.start.character).toBe(20);
    expect(refs[0].range.end.character).toBe(26);
  });

  it('extracts [[Display->Target]] with the target range', () => {
    const refs = parseLinks('[[go -> Target]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Target');
    expect(refs[0].range.start.character).toBe(8);
    expect(refs[0].range.end.character).toBe(14);
  });

  it('extracts [[Target<-Display]] with the target range', () => {
    const refs = parseLinks('[[Target<-go]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Target');
    expect(refs[0].range.start.character).toBe(2);
    expect(refs[0].range.end.character).toBe(8);
  });

  it('gives the pipe precedence over arrows, like Spindle', () => {
    expect(parseLinks('[[a->b|Target]]')[0].name).toBe('Target');
    expect(parseLinks('[[x<-a->Target]]')[0].name).toBe('Target');
  });

  it('skips a .class#id prefix', () => {
    const refs = parseLinks('[[.fancy#door Enter->Hall]]');
    expect(refs[0].name).toBe('Hall');
    expect(refs[0].range.start.character).toBe(21);
  });

  it('ignores links with an empty target', () => {
    expect(parseLinks('[[go->]] [[ ]]')).toHaveLength(0);
  });
});
