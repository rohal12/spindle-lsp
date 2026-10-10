import { widgetDefinitions, type ToolingMacro } from '@rohal12/spindle/tooling';
import type { WidgetDef } from '../types.js';
import type { PassageMarkup } from '../markup/passage-markup.js';
import { macroTokens } from '../markup/tokens.js';

/**
 * Registry of user-defined widgets, as the runtime registers them: the
 * `{widget "name" @params}` definitions of `StoryInit` and of the passages
 * tagged `widget` (read by the tooling API's `widgetDefinitions`), and the
 * macros each document calls.
 */
export class WidgetRegistry {
  /** Widgets keyed by lower-cased name; Spindle resolves widgets case-insensitively. */
  private widgets = new Map<string, WidgetDef>();

  /** Per-URI set of lower-cased macro names opened in that document. */
  private invokedByUri = new Map<string, Set<string>>();

  /**
   * Read the widget definitions of `passages` (all of them, in workspace
   * order; a name defined twice keeps the later definition, as when the
   * runtime registers them).
   */
  scan(passages: Iterable<PassageMarkup>, macros: Iterable<ToolingMacro>): void {
    this.widgets.clear();
    const known = [...macros];

    for (const markup of passages) {
      if (!markup.isMarkup) continue;
      const { name, tags } = markup.passage;
      for (const definition of widgetDefinitions([{ name, tags, content: markup.content }], known)) {
        this.widgets.set(definition.name.toLowerCase(), {
          name: definition.name,
          params: definition.params,
          uri: markup.passage.uri,
          range: markup.range(definition.start, definition.end),
          nameRange: markup.range(definition.nameStart, definition.nameEnd),
          block: definition.block,
        });
      }
    }
  }

  /** Get a widget definition by name (case-insensitive). */
  getWidget(name: string): WidgetDef | undefined {
    return this.widgets.get(name.toLowerCase());
  }

  /** Get all registered widget definitions. */
  getAllWidgets(): WidgetDef[] {
    return Array.from(this.widgets.values());
  }

  /**
   * Record the macros opened in a document (its tags and those in the labels
   * and attribute values that hold markup), replacing any previous record for
   * that URI. Spindle resolves widget names case-insensitively, so names are
   * stored lower-cased.
   */
  recordInvocations(uri: string, passages: readonly PassageMarkup[]): void {
    const names = new Set<string>();
    for (const passage of passages) {
      for (const macro of macroTokens(passage)) {
        if (!macro.isClose) names.add(macro.name.toLowerCase());
      }
    }
    this.invokedByUri.set(uri, names);
  }

  /** Forget all recorded invocations. */
  clearInvocations(): void {
    this.invokedByUri.clear();
  }

  /** Whether any recorded document invokes the widget `{name}`. */
  isInvoked(name: string): boolean {
    const key = name.toLowerCase();
    for (const names of this.invokedByUri.values()) {
      if (names.has(key)) return true;
    }
    return false;
  }
}
