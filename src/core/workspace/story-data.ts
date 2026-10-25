import { createRequire as createCompilerRequire } from 'node:module';
import type { ReadonlyStory } from '@rohal12/twee-ts';

/**
 * Read metadata through the public compiler, including its case folding,
 * repeated fields and null semantics. Keep source text separately for edits:
 * the builder canonicalizes the stored StoryData passage.
 */
export function readStoryData(content: string): ReadonlyStory['twine2'] {
  const { StoryBuilder } = createCompilerRequire(import.meta.url)('@rohal12/twee-ts') as typeof import('@rohal12/twee-ts');
  const builder = new StoryBuilder();
  builder.add({ name: 'StoryData', tags: [], text: content }, []);
  return builder.build().twine2;
}
