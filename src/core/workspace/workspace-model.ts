import { EventEmitter } from 'node:events';
import { DocumentStore } from './document-store.js';
import { PassageIndex } from './passage-index.js';
import { MacroRegistry } from './macro-registry.js';
import { VariableTracker } from './variable-tracker.js';
import { WidgetRegistry } from './widget-registry.js';
import { parseMacros } from '../parsing/macro-parser.js';
import supplements from '../../macro-supplements.json' with { type: 'json' };

export interface WorkspaceModelConfig {
  disabledPlugins?: string[];
}

/**
 * Orchestrates all workspace-level data structures.
 *
 * Event cascade on document change:
 *   document change → passage rebuild → widget/variable rescan → emit 'modelReady'
 *
 * Changes are debounced at 200ms for rapid edits.
 */
export class WorkspaceModel extends EventEmitter {
  readonly documents: DocumentStore;
  readonly passages: PassageIndex;
  readonly macros: MacroRegistry;
  readonly variables: VariableTracker;
  readonly widgets: WidgetRegistry;

  /** True after initialize() has completed (full workspace scan done). */
  initialized = false;

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
    if (text !== undefined) {
      this.passages.rebuild(uri, text);
    }
    this.cascade();
    this.emit('documentChanged', uri);
    this.emit('passagesUpdated', uri);
    this.scheduleModelReady();
  }

  /** Handle a document close: remove its passages and cascade. */
  private handleDocumentClose(uri: string): void {
    this.passages.remove(uri);
    this.cascade();
    this.emit('documentClosed', uri);
    this.emit('passagesUpdated', uri);
    this.scheduleModelReady();
  }

  /** Rebuild all indices from scratch. */
  private rebuildAll(): void {
    for (const uri of this.documents.getUris()) {
      const text = this.documents.getText(uri);
      if (text !== undefined) {
        this.passages.rebuild(uri, text);
      }
    }
    this.cascade();
  }

  /**
   * Cascade: rescan variables and widgets based on current passages.
   * Called after any passage index update.
   */
  private cascade(): void {
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
          if (/^::\s+/.test(lines[i])) {
            contentEnd = i;
            break;
          }
        }
        const content = lines.slice(contentStart, contentEnd).join('\n');
        this.variables.parseStoryVariables(content);
      }
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
          if (/^::\s+/.test(lines[i])) {
            contentEnd = i;
            break;
          }
        }
        const content = lines.slice(contentStart, contentEnd).join('\n');
        this.variables.parseStoryTransients(content);
      }
    }

    // Rescan variable usages across all documents
    for (const uri of this.documents.getUris()) {
      const text = this.documents.getText(uri);
      if (text) {
        const macros = parseMacros(text);
        this.variables.scanDocument(uri, text, macros);
      }
    }

    // Rescan widgets
    const allPassages = this.passages.getAllPassages();
    this.widgets.scan(allPassages, (uri) => this.documents.getText(uri));
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
