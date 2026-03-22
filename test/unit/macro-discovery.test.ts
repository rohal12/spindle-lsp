import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { discoverMacrosFromSource, discoverMacrosFromStoryInit } from '../../src/core/parsing/macro-discovery.js';

describe('discoverMacrosFromSource', () => {
  it('extracts macros from TS source', () => {
    const source = readFileSync(resolve(__dirname, '../fixtures/custom-macros.ts'), 'utf-8');
    const macros = discoverMacrosFromSource(source);
    expect(macros).toHaveLength(2);
    expect(macros[0].name).toBe('agebox');
    expect(macros[0].storeVar).toBe(true);
    expect(macros[0].description).toBe('Age selection box');
    expect(macros[1].name).toBe('chargenOption');
    expect(macros[1].merged).toBe(true);
    expect(macros[1].block).toBe(true);
    expect(macros[1].subMacros).toEqual(['option']);
  });

  it('returns empty for source without defineMacro', () => {
    expect(discoverMacrosFromSource('const x = 1;')).toHaveLength(0);
  });

  it('handles malformed config gracefully', () => {
    const source = 'Story.defineMacro({ name: computed() });';
    expect(() => discoverMacrosFromSource(source)).not.toThrow();
  });
});

describe('discoverMacrosFromStoryInit', () => {
  it('extracts from StoryInit passage content', () => {
    const content = `{do}
Story.defineMacro({
  name: 'custom',
  block: true,
  render: () => null,
});
{/do}`;
    const macros = discoverMacrosFromStoryInit(content);
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('custom');
    expect(macros[0].block).toBe(true);
  });
});
