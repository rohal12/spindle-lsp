import { widgetDefinitions, type ToolingMacro, type WidgetDefinition } from '@rohal12/spindle/tooling';
import type { PassageMarkup } from './passage-markup.js';

/** Keep source identity before tooling selects the runtime's effective widgets. */
export function widgetSources(
  passages: Iterable<PassageMarkup>,
  macros: readonly ToolingMacro[],
): Map<WidgetDefinition, PassageMarkup> {
  const sources = new Map<WidgetDefinition, PassageMarkup>();
  for (const passage of passages) {
    if (!passage.isMarkup) continue;
    const { name, tags } = passage.passage;
    for (const definition of widgetDefinitions([{ name, tags, content: passage.content }], macros)) {
      sources.set(definition, passage);
    }
  }
  return sources;
}
