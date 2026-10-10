import { EventEmitter } from 'node:events';
import { DocumentStore } from './document-store.js';
import { PassageIndex } from './passage-index.js';
import { MacroRegistry } from './macro-registry.js';
import { VariableTracker, BUILTIN_STORE_VAR_MACROS } from './variable-tracker.js';
import { WidgetRegistry } from './widget-registry.js';
import { MarkupIndex } from '../markup/markup-index.js';
import { parseDocumentMacros, type MacroHeadPairing } from '../parsing/macro-parser.js';
import { discoverMacrosFromSource, discoverMacrosFromStoryInit } from '../parsing/macro-discovery.js';
import type { DiscoveredMacro } from '../parsing/macro-discovery.js';
import { isMacroSource } from './macro-sources.js';
import {
  UNDECLARED_STORY_FORMAT,
  resolveStoryFormat,
  storyDataFormats,
  storyDataFormatVersion,
} from './story-format.js';
import { DEFAULT_CAPABILITIES, readInstalledSpindleVersion, resolveSpindleCapabilities } from './spindle-version.js';
import type { SpindleCapabilities } from './spindle-version.js';
import type { StoryFormat } from './story-format.js';
import supplements from '../../macro-supplements.json' with { type: 'json' };

export interface WorkspaceModelConfig {
  disabledPlugins?: string[];
  /**
   * Directory of the story project. Builtin macros are read from the
   * @rohal12/spindle installed there (or in an ancestor's node_modules).
   */
  workspaceRoot?: string;
}

/**
 * Orchestrates all workspace-level data structures.
 *
 * Event cascade on document change:
 *   document change → passage rebuild → widget/variable rescan → emit 'modelReady'
 *
 * Changes are debounced at 200ms for rapid edits.
 *
 * Also emits 'storyFormatChanged' when the story format declared by
 * StoryData changes (see {@link isSpindleProject}).
 */
export class WorkspaceModel extends EventEmitter {
  readonly documents: DocumentStore;
  readonly passages: PassageIndex;
  readonly macros: MacroRegistry;
  readonly variables: VariableTracker;
  readonly widgets: WidgetRegistry;
  /** Every document's markup, read through Spindle's tooling API. */
  readonly markup: MarkupIndex;

  /** True after initialize() has completed (full workspace scan done). */
  initialized = false;

  /** The story format declared by StoryData, updated with the passages. */
  private format: StoryFormat = UNDECLARED_STORY_FORMAT;

  /**
   * The Spindle the project targets: the version installed under the
   * workspace root, else StoryData's `format-version`, else the behavior of
   * Spindle 0.45.1 (see {@link resolveSpindleCapabilities}).
   */
  capabilities: SpindleCapabilities = DEFAULT_CAPABILITIES;

  private readonly workspaceRoot: string | undefined;
  /** The version installed under the workspace root, read at startup and on refresh(). */
  private installedVersion: string | undefined;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 200;

  /** Bound listeners for cleanup in dispose(). */
  private onDocumentChanged: (uri: string) => void;
  private onDocumentOpened: (uri: string) => void;
  private onDocumentClosed: (uri: string) => void;

  constructor(config?: WorkspaceModelConfig) {
    super();
    this.documents = new DocumentStore();
    this.passages = new PassageIndex();
    this.macros = new MacroRegistry();
    this.variables = new VariableTracker();
    this.widgets = new WidgetRegistry();
    this.markup = new MarkupIndex({
      text: (uri) => this.documents.getText(uri),
      passages: (uri) => this.passages.getPassagesInDocument(uri),
      context: () => ({
        macros: this.macros.toolingMacros(),
        isBlock: (name) => this.isContainer(name),
      }),
    });

    this.workspaceRoot = config?.workspaceRoot;
    this.installedVersion = this.workspaceRoot ? readInstalledSpindleVersion(this.workspaceRoot) : undefined;
    this.capabilities = resolveSpindleCapabilities(this.installedVersion);
    this.variables.setCapabilities(this.capabilities);

    // Load builtins + supplements eagerly so macros are available
    // even before initialize() is called (LSP didOpen may arrive first)
    this.macros.loadBuiltins();
    this.macros.loadSupplements(supplements as Record<string, any>);

    // Bind event handlers
    this.onDocumentChanged = (uri: string) => this.handleDocumentChange(uri);
    this.onDocumentOpened = (uri: string) => this.handleDocumentChange(uri);
    this.onDocumentClosed = (uri: string) => this.handleDocumentClose(uri);

    // Wire up the event cascade
    this.documents.on('documentChanged', this.onDocumentChanged);
    this.documents.on('documentOpened', this.onDocumentOpened);
    this.documents.on('documentClosed', this.onDocumentClosed);
  }

  /**
   * Initialize the workspace in CLI/batch mode.
   * Loads all file contents, builds indices, and emits 'modelReady'.
   */
  initialize(fileContents: Map<string, string>): void {

    // Load all documents (this triggers documentOpened for each, which
    // will rebuild passages, but we do a bulk rebuild below anyway)
    // Temporarily detach listeners to avoid per-document cascading
    this.documents.removeListener('documentOpened', this.onDocumentOpened);
    this.documents.removeListener('documentChanged', this.onDocumentChanged);

    for (const [uri, text] of fileContents) {
      this.documents.open(uri, text);
    }

    // Reattach listeners
    this.documents.on('documentOpened', this.onDocumentOpened);
    this.documents.on('documentChanged', this.onDocumentChanged);

    // Bulk rebuild
    this.rebuildAll();

    this.initialized = true;

    // Schedule modelReady emission
    this.scheduleModelReady();
  }

  /**
   * Re-run cross-document analysis and schedule 'modelReady', e.g. after
   * the macro configuration changed without any document changing.
   */
  refresh(): void {
    // The project's Spindle may have been upgraded meanwhile
    if (this.workspaceRoot) this.installedVersion = readInstalledSpindleVersion(this.workspaceRoot);
    this.cascade();
    this.scheduleModelReady();
  }

  /**
   * Whether `{name}` opens a container that needs a `{/name}` closing tag:
   * a block macro, or a block widget (one whose body renders `{@children}`).
   * Like Spindle's set of block macros, either source makes a name a block.
   */
  isContainer(name: string): boolean {
    return this.macros.isBlock(name) || (this.widgets.getWidget(name)?.block ?? false);
  }

  /**
   * Whether document `uri` declares any passage. A Twee document with no
   * `::` header holds no passage (the compiler ignores text outside one), so
   * there is no markup in it for any consumer to read.
   */
  hasPassages(uri: string): boolean {
    return this.passages.getPassagesInDocument(uri).length > 0;
  }

  /** Per-passage closer pairing for the macro heads of document `uri`. */
  macroHeadPairing(uri: string): MacroHeadPairing {
    return {
      isBlock: (name) => this.isContainer(name),
      passages: this.passages.getPassagesInDocument(uri),
      rawDoBodies: this.capabilities.rawDoBodies,
      stringAwareBraces: this.capabilities.stringAwareBraces,
    };
  }

  /**
   * The story format named by the project's StoryData passage (trimmed), or
   * undefined if no StoryData passage names one.
   */
  get storyFormat(): string | undefined {
    return this.format.name;
  }

  /**
   * Whether Spindle semantics apply to this project. False only if a
   * StoryData passage names another story format (SugarCube, Harlowe, ...)
   * and none names Spindle; a missing or unreadable StoryData counts as
   * Spindle.
   */
  isSpindleProject(): boolean {
    return this.format.isSpindle;
  }

  /** Clean up listeners and timers. */
  dispose(): void {
    this.documents.removeListener('documentChanged', this.onDocumentChanged);
    this.documents.removeListener('documentOpened', this.onDocumentOpened);
    this.documents.removeListener('documentClosed', this.onDocumentClosed);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.removeAllListeners();
  }

  /** Handle a document change: rebuild passages for that document, then cascade. */
  private handleDocumentChange(uri: string): void {
    const text = this.documents.getText(uri);
    // JS/TS macro sources only feed macro discovery — they hold no passages
    if (text !== undefined && !isMacroSource(uri)) {
      this.passages.rebuild(uri, text);
    }
    this.refreshDiscoveredMacros();
    this.cascade();
    this.updateStoryFormat();
    this.emit('documentChanged', uri);
    this.emit('passagesUpdated', uri);
    this.scheduleModelReady();
  }

  /** Handle a document close: remove its passages and variable usages, then cascade. */
  private handleDocumentClose(uri: string): void {
    this.passages.remove(uri);
    this.variables.removeDocument(uri);
    this.refreshDiscoveredMacros();
    this.cascade();
    this.updateStoryFormat();
    this.emit('documentClosed', uri);
    this.emit('passagesUpdated', uri);
    this.scheduleModelReady();
  }

  /** Rebuild all indices from scratch. */
  private rebuildAll(): void {
    for (const uri of this.documents.getUris()) {
      const text = this.documents.getText(uri);
      if (text !== undefined && !isMacroSource(uri)) {
        this.passages.rebuild(uri, text);
      }
    }
    this.refreshDiscoveredMacros();
    this.cascade();
    this.updateStoryFormat();
  }

  /**
   * Re-read the story format from the StoryData passages after the passage
   * index changed, emitting 'storyFormatChanged' if it differs. Called after
   * the cascade, so listeners see up-to-date indices.
   */
  private updateStoryFormat(): void {
    const format = resolveStoryFormat(storyDataFormats(
      this.passages.getAllPassages(),
      (uri) => this.documents.getText(uri),
    ));
    if (format.name === this.format.name && format.isSpindle === this.format.isSpindle) return;
    this.format = format;
    this.emit('storyFormatChanged', format);
  }

  /**
   * Re-run static macro discovery over the workspace and replace the
   * registry's discovered tier (dropping definitions whose source is gone).
   *
   * Sources scanned for Story.defineMacro({...}) calls:
   *  - `{do}` blocks in StoryInit passages
   *  - passages tagged `script` (Story JavaScript)
   *  - JavaScript/TypeScript documents in the workspace
   */
  private refreshDiscoveredMacros(): void {
    const found: DiscoveredMacro[] = [];

    for (const uri of this.documents.getUris()) {
      const text = this.documents.getText(uri);
      if (!text) continue;

      if (isMacroSource(uri)) {
        found.push(...discoverMacrosFromSource(text));
        continue;
      }

      let lines: string[] | undefined;
      for (const passage of this.passages.getPassagesInDocument(uri)) {
        const isStoryInit = passage.name === 'StoryInit';
        const isScript = passage.tags?.includes('script') ?? false;
        if (!isStoryInit && !isScript) continue;

        lines ??= text.split('\n');
        const content = lines
          .slice(passage.headerEnd.end.line + 1, passage.range.end.line + 1)
          .join('\n');
        found.push(...(isScript
          ? discoverMacrosFromSource(content)
          : discoverMacrosFromStoryInit(content)));
      }
    }

    this.macros.setDiscoveredMacros(found);
  }

  /**
   * Cascade: rescan variables and widgets based on current passages.
   * Called after any passage index update.
   */
  private cascade(): void {
    // The target version decides how variables are scanned and validated
    this.capabilities = resolveSpindleCapabilities(
      this.installedVersion,
      storyDataFormatVersion(this.passages.getAllPassages(), (uri) => this.documents.getText(uri)),
    );
    this.variables.setCapabilities(this.capabilities);

    // Rescan StoryVariables
    const storyVars = this.passages.getStoryVariables();
    if (storyVars) {
      const text = this.documents.getText(storyVars.uri);
      if (text) {
        const lines = text.split('\n');
        const contentStart = storyVars.headerEnd.end.line + 1;
        // Find end of this passage
        let contentEnd = lines.length;
        for (let i = contentStart; i < lines.length; i++) {
          if (/^\uFEFF?::\s+/.test(lines[i])) {
            contentEnd = i;
            break;
          }
        }
        const content = lines.slice(contentStart, contentEnd).join('\n');
        this.variables.parseStoryVariables(content, contentStart, storyVars.uri);
      }
    } else {
      this.variables.clearStoryVariables();
    }

    // Rescan StoryTransients
    const storyTransients = this.passages.getStoryTransients();
    if (storyTransients) {
      const text = this.documents.getText(storyTransients.uri);
      if (text) {
        const lines = text.split('\n');
        const contentStart = storyTransients.headerEnd.end.line + 1;
        let contentEnd = lines.length;
        for (let i = contentStart; i < lines.length; i++) {
          if (/^\uFEFF?::\s+/.test(lines[i])) {
            contentEnd = i;
            break;
          }
        }
        const content = lines.slice(contentStart, contentEnd).join('\n');
        this.variables.parseStoryTransients(content, contentStart, storyTransients.uri);
      }
    } else {
      this.variables.clearStoryTransients();
    }

    // Rescan variable usages and macro invocations across all story documents
    const storeVarMacros = new Set(BUILTIN_STORE_VAR_MACROS);
    for (const m of this.macros.getAllMacros()) {
      if (m.storeVar) storeVarMacros.add(m.name.toLowerCase());
    }
    this.widgets.clearInvocations();
    for (const uri of this.documents.getUris()) {
      const text = this.documents.getText(uri);
      // Empty documents are scanned too, dropping their previous usages
      if (text !== undefined && !isMacroSource(uri)) {
        const macros = parseDocumentMacros(text, this.passages.getPassagesInDocument(uri), undefined, this.capabilities);
        this.variables.scanDocument(uri, text, macros, storeVarMacros);
        this.widgets.recordInvocations(uri, macros);
      }
    }

    // Rescan widgets
    const allPassages = this.passages.getAllPassages();
    this.widgets.scan(allPassages, (uri) => this.documents.getText(uri));

    // Macros and widgets decide how every document's markup pairs and what it runs
    this.markup.invalidate();
  }

  /** Debounce modelReady emission. */
  private scheduleModelReady(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.emit('modelReady');
    }, this.DEBOUNCE_MS);
  }
}
