import type { Passage, WidgetDef, Range } from '../types.js';

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
}
