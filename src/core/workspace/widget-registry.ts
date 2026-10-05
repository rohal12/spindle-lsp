import type { MacroNode, Passage, WidgetDef, Range } from '../types.js';

/** Regex matching {widget "name" @param1 @param2} definitions. */
const widgetDefRegex = /\{widget\s+"([^"]+)"((?:\s+@[A-Za-z_$][\w$]*)*)\s*\}/gi;

/** Regex extracting individual @param names from the parameter string. */
const paramRegex = /@([A-Za-z_$][\w$]*)/g;

/**
 * Registry of user-defined widgets.
 * Scans passages tagged [widget] for {widget "name" @params} definitions.
 */
export class WidgetRegistry {
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
        if (/^::\s+/.test(lines[i])) {
          contentEndLine = i;
          break;
        }
      }

      const contentLines = lines.slice(contentStartLine, contentEndLine);

      for (let i = 0; i < contentLines.length; i++) {
        const line = contentLines[i];
        widgetDefRegex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = widgetDefRegex.exec(line)) !== null) {
          const widgetName = match[1];
          const paramString = match[2] || '';
          const params: string[] = [];
          let paramMatch: RegExpExecArray | null;
          paramRegex.lastIndex = 0;
          while ((paramMatch = paramRegex.exec(paramString)) !== null) {
            params.push(paramMatch[1]);
          }

          const lineNum = contentStartLine + i;
          const charStart = match.index;
          const charEnd = charStart + match[0].length;

          const range: Range = {
            start: { line: lineNum, character: charStart },
            end: { line: lineNum, character: charEnd },
          };

          this.widgets.set(widgetName, {
            name: widgetName,
            params,
            uri: passage.uri,
            range,
          });
        }
      }
    }
  }

  /** Get a widget definition by name. */
  getWidget(name: string): WidgetDef | undefined {
    return this.widgets.get(name);
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
