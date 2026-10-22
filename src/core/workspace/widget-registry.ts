import { effectiveWidgetDefinitions, type ToolingMacro } from '@rohal12/spindle/tooling';
import type { Position, WidgetDef } from '../types.js';
import type { PassageMarkup } from '../markup/passage-markup.js';
import { macroTokens } from '../markup/tokens.js';
import { widgetSources } from '../markup/widgets.js';

/**
 * Registry of user-defined widgets, as the runtime registers them: the
 * `{widget "name" @params}` definitions of `StoryInit` and of the passages
 * tagged `widget` (read by the tooling API's `widgetDefinitions`), and the
 * macros each document calls.
 */
export class WidgetRegistry {
  /** Widgets keyed by lower-cased name; Spindle resolves widgets case-insensitively. */
  private widgets = new Map<string, WidgetDef>();

  /** Half-typed declarations remain discoverable in the editor, without replacing effective widgets. */
  private incomplete = new Map<string, WidgetDef>();

  /** Per-URI set of lower-cased macro names opened in that document. */
  private invokedByUri = new Map<string, Set<string>>();

  /**
   * Read the widget definitions of `passages` (all of them, in workspace
   * order). Public tooling selects the closed definitions in runtime phase
   * order, preserving their identities so the original source is retained.
   */
  scan(passages: Iterable<PassageMarkup>, macros: Iterable<ToolingMacro>): void {
    this.widgets.clear();
    this.incomplete.clear();
    const sources = widgetSources(passages, [...macros]);
    const effective = new Set(effectiveWidgetDefinitions([...sources.keys()]));
    for (const [definition, markup] of sources) {
      const widget: WidgetDef = {
        tooling: definition,
        name: definition.name,
        params: definition.params,
        uri: markup.passage.uri,
        range: markup.range(definition.start, definition.end),
        nameRange: markup.range(definition.nameStart, definition.nameEnd),
        block: definition.block,
      };
      const key = definition.name.toLowerCase();
      if (effective.has(definition)) this.widgets.set(key, widget);
      else if (definition.closeStart === undefined) this.incomplete.set(key, widget);
    }
  }

  /** The effective definition, or an incomplete declaration while its first definition is being typed. */
  getWidget(name: string): WidgetDef | undefined {
    const key = name.toLowerCase();
    return this.widgets.get(key) ?? this.incomplete.get(key);
  }

  /** Get the effective registered definitions, excluding incomplete editor declarations. */
  getAllWidgets(): WidgetDef[] {
    return Array.from(this.widgets.values());
  }

  /** The effective widget whose declared name contains the cursor. */
  definitionAt(uri: string, position: Position): WidgetDef | undefined {
    return this.getAllWidgets().find(widget => {
      const { start, end } = widget.nameRange;
      return widget.uri === uri && position.line === start.line &&
        position.character >= start.character && position.character <= end.character;
    });
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
