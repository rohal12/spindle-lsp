import { expect, it, vi } from 'vitest';
import { WorkspaceModel } from '../../src/core/workspace/workspace-model.js';
import { findLiteralLinkInterpolations } from '../../src/core/parsing/link-parser.js';

const measured = vi.hoisted(() => ({ input: 0 }));

// Run the real public readers, counting the input exposed to repeated scans
// versus a shared index. Unmatched prefixes require scanning their suffix.
vi.mock('@rohal12/spindle/tooling', async importOriginal => {
  const actual = await importOriginal<typeof import('@rohal12/spindle/tooling') & {
    indexStrictCodeEnds?: (source: string) => (start: number) => number;
  }>();
  return {
    ...actual,
    findCodeEnd: (...args: Parameters<typeof actual.findCodeEnd>) => {
      const [source, start] = args;
      measured.input += source.length - start;
      return actual.findCodeEnd(...args);
    },
    ...(actual.indexStrictCodeEnds ? {
      indexStrictCodeEnds: (source: string) => {
        measured.input += source.length;
        const endAt = actual.indexStrictCodeEnds!(source);
        return (start: number) => { measured.input++; return endAt(start); };
      },
    } : {}),
  };
});

it.each([256, 512])('bounds aggregate boundary input for %i unmatched literal prefixes (#320)', count => {
  const target = '{$x'.repeat(count) + '{$good}';
  const uri = 'memory:///story.tw';
  const model = new WorkspaceModel();
  try {
    model.initialize(new Map([[uri, `:: StoryVariables\n:: Start\n[[go->${target}]]`]]));
    measured.input = 0;
    const found = findLiteralLinkInterpolations(model.markup.get(uri)!);
    expect(found.map(span => span.block)).toEqual(['{$good}']);
    expect(measured.input).toBeGreaterThan(0);
    expect(measured.input).toBeLessThan(target.length * 10);
  } finally {
    model.dispose();
  }
});
