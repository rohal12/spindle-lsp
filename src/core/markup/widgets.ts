import { widgetDefinitions, type ToolingMacro, type WidgetDefinition } from '@rohal12/spindle/tooling';
import type { PassageMarkup } from './passage-markup.js';

/** Keep source identity before tooling selects the runtime's effective widgets. */
export function widgetSources(
  passages: Iterable<PassageMarkup>,
  macros: readonly ToolingMacro[],
): Map<WidgetDefinition, PassageMarkup> {
  const sources = new Map<WidgetDefinition, PassageMarkup>();
  const markups = [...passages].filter(passage => passage.isMarkup);
  // Tooling returns only a passage name, so use source keys during discovery
  // to distinguish duplicate headers/files. Restore real names before callers
  // select effective definitions (StoryInit registers last).
  const inputs = markups.map((passage, index) => ({
    name: String(index),
    // Keep StoryInit discoverable under its source key; tooling selects all
    // other passages using their original tags.
    tags: passage.passage.name === 'StoryInit' ? [...(passage.passage.tags ?? []), 'widget'] : passage.passage.tags,
    content: passage.content,
  }));
  for (const definition of widgetDefinitions(inputs, macros)) {
    const passage = markups[Number(definition.passage)];
    definition.passage = passage.passage.name;
    sources.set(definition, passage);
  }
  return sources;
}
