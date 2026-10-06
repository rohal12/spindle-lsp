import type { MacroNode, Passage, WidgetDef, Range } from '../types.js';
import { buildLineStarts, offsetToPosition } from '../parsing/macro-parser.js';

/**
 * Regex matching `{widget name ...}` definitions. Mirrors Spindle's startup
 * scan: the name may be double-quoted, single-quoted or bare.
 * Groups: 1 = text before the name, 2 = name, 3 = remaining argument tokens.
 */
const widgetDefRegex = /(\{widget\s+["']?)([^\s"'}]+)["']?([^}]*)\}/gi;

/**
 * Extract widget parameters the way Spindle does: every argument token after
 * the name that starts with `$`, `_` or `@`, except the implicit `@children`.
 */
function parseParams(argString: string): string[] {
  return argString
    .trim()
    .split(/\s+/)
    .filter(t => /^[$_@]/.test(t) && t !== '@children');
}

/**
 * Registry of user-defined widgets.
 * Scans passages tagged [widget] for {widget "name" @params} definitions.
 */
export class WidgetRegistry {
  /** Widgets keyed by lower-cased name; Spindle resolves widgets case-insensitively. */
  private widgets = new Map<string, WidgetDef>();

  /** Per-URI set of lower-cased macro names opened in that document. */
  private invokedByUri = new Map<string, Set<string>>();

  /**
   * Scan all passages for widget definitions.
   * Only passages tagged `widget` are examined.
   *
   * @param passages - All known passages.
   * @param getContent - Function to retrieve document text by URI.
   */
  scan(passages: Passage[], getContent: (uri: string) => string | undefined): void {
    this.widgets.clear();

    for (const passage of passages) {
      if (!passage.tags?.includes('widget')) continue;

      const text = getContent(passage.uri);
      if (!text) continue;

      // Get the passage content (lines after the header)
      const lines = text.split('\n');
      const contentStartLine = passage.range.start.line + 1;
      // Find the end of this passage (next header or EOF)
      let contentEndLine = lines.length;
      for (let i = contentStartLine; i < lines.length; i++) {
        if (/^\uFEFF?::\s+/.test(lines[i])) {
          contentEndLine = i;
          break;
        }
      }

      const content = lines.slice(contentStartLine, contentEndLine).join('\n');
      const lineStarts = buildLineStarts(content);
      const toPosition = (offset: number) => {
        const pos = offsetToPosition(offset, lineStarts);
        return { line: contentStartLine + pos.line, character: pos.character };
      };

      widgetDefRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = widgetDefRegex.exec(content)) !== null) {
        const widgetName = match[2];
        const nameStart = match.index + match[1].length;

        const range: Range = {
          start: toPosition(match.index),
          end: toPosition(match.index + match[0].length),
        };
        const nameRange: Range = {
          start: toPosition(nameStart),
          end: toPosition(nameStart + widgetName.length),
        };

        // Like Spindle, a widget whose body contains {@children} is a block widget
        const bodyStart = match.index + match[0].length;
        const rest = content.slice(bodyStart);
        const closeIdx = rest.search(/\{\/widget\}/i);
        const body = closeIdx >= 0 ? rest.slice(0, closeIdx) : rest;

        this.widgets.set(widgetName.toLowerCase(), {
          name: widgetName,
          params: parseParams(match[3]),
          uri: passage.uri,
          range,
          nameRange,
          block: /\{@children\}/.test(body),
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
   * Record the macro names opened in a document, replacing any previous
   * record for that URI. Spindle resolves widget names case-insensitively,
   * so names are stored lower-cased.
   */
  recordInvocations(uri: string, macros: MacroNode[]): void {
    const names = new Set<string>();
    for (const macro of macros) {
      if (macro.open) names.add(macro.name.toLowerCase());
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
