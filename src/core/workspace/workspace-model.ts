import { EventEmitter } from 'node:events';
import { discoverMacros } from '@rohal12/spindle/tooling';
import type { DiscoveredMacro } from '@rohal12/spindle/tooling';
import { DocumentStore } from './document-store.js';
import { compareSourceUris, PassageIndex } from './passage-index.js';
import { MacroRegistry } from './macro-registry.js';
import { VariableTracker } from './variable-tracker.js';
import { WidgetRegistry } from './widget-registry.js';
import { MarkupIndex } from '../markup/markup-index.js';
import type { PassageMarkup } from '../markup/passage-markup.js';
import { isMacroSource } from './macro-sources.js';
import {
  UNDECLARED_STORY_FORMAT,
  resolveStoryFormat,
  storyDataFormats,
  storyDataFormatVersion,
} from './story-format.js';
import { readInstalledSpindleVersion, resolveSpindleTarget } from './spindle-version.js';
import type { SpindleTarget } from './spindle-version.js';
import type { StoryFormat } from './story-format.js';
import type { Passage } from '../types.js';
import { isRuntimePassage } from '../parsing/passage-parser.js';
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
 * The macros defined in the `{do}` code of a StoryInit passage's `content`
 * (the code the tooling API finds in it).
 */
function storyInitMacros(passage: PassageMarkup): DiscoveredMacro[] {
  return passage.pieces
    .flatMap((piece) => piece.kind === 'code' && piece.goal === 'statements' ? discoverMacros(piece.code) : []);
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
  private readonly _macros: MacroRegistry;
  get macros(): MacroRegistry {
    this.ensureCurrent();
    return this._macros;
  }
  private readonly _variables: VariableTracker;
  get variables(): VariableTracker {
    this.ensureCurrent();
    return this._variables;
  }
  private readonly _widgets: WidgetRegistry;
  get widgets(): WidgetRegistry {
    this.ensureCurrent();
    return this._widgets;
  }
  /** Every document's markup, read through Spindle's tooling API. */
  private readonly _markup: MarkupIndex;
  get markup(): MarkupIndex {
    this.ensureCurrent();
    return this._markup;
  }

  /** True after initialize() has completed (full workspace scan done). */
  initialized = false;

  /** The story format declared by StoryData, updated with the passages. */
  private format: StoryFormat = UNDECLARED_STORY_FORMAT;

  /**
   * The Spindle the project targets: the version installed under the
   * workspace root, else StoryData's `format-version`. Only a version below
   * {@link MINIMUM_SPINDLE_VERSION} matters (it is reported, not emulated).
   */
  private _target: SpindleTarget;
  get target(): SpindleTarget {
    this.ensureCurrent();
    return this._target;
  }

  private readonly workspaceRoot: string | undefined;
  /** The version installed under the workspace root, read at startup and on refresh(). */
  private installedVersion: string | undefined;
  /** The `format-version` StoryData declares. */
  private declaredVersion: string | undefined;

  private analysisPending = false;

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
    this._macros = new MacroRegistry();
    this.macros.onChange = () => this.markup?.invalidate();
    this._variables = new VariableTracker();
    this._widgets = new WidgetRegistry();
    this._markup = new MarkupIndex({
      text: (uri) => this.documents.getText(uri),
      passages: (uri) => this.passages.getPassagesInDocument(uri),
      context: () => ({
        macros: this.toolingMacros(),
        isBlock: (name) => this.isContainer(name),
      }),
    });

    this.workspaceRoot = config?.workspaceRoot;
    this.installedVersion = this.workspaceRoot ? readInstalledSpindleVersion(this.workspaceRoot) : undefined;
    this._target = resolveSpindleTarget(this.installedVersion);

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

    // The batch is already fully analyzed. Publish it before returning,
    // rather than leaving a stale initialization event among later requests.
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.emit('modelReady');
  }

  /**
   * Re-run cross-document analysis and schedule 'modelReady', e.g. after
   * the macro configuration changed without any document changing.
   */
  refresh(): void {
    // The project's Spindle may have been upgraded meanwhile
    if (this.workspaceRoot) this.installedVersion = readInstalledSpindleVersion(this.workspaceRoot);
    this.analysisPending = true;
    this.ensureCurrent();
    this.scheduleModelReady();
  }

  /**
   * Whether `{name}` opens a container that needs a `{/name}` closing tag:
   * a block macro, or a block widget (one whose body renders `{@children}`).
   * A same-name block macro retains its syntax when a widget owns the call.
   */
  isContainer(name: string): boolean {
    return this.macros.isBlock(name) || (this.widgets.getWidget(name)?.block ?? false);
  }

  /** Runtime macro metadata, after effective widgets have claimed their names. */
  getEffectiveMacro(name: string) {
    return this.widgets.getEffectiveWidget(name) ? undefined : this.macros.getMacro(name);
  }

  /**
   * Whether document `uri` declares any passage. A Twee document with no
   * `::` header holds no passage (the compiler ignores text outside one), so
   * there is no markup in it for any consumer to read.
   */
  hasPassages(uri: string): boolean {
    return this.passages.getPassagesInDocument(uri).length > 0;
  }

  /**
   * The story format named by the project's StoryData passage (trimmed), or
   * undefined if no StoryData passage names one.
   */
  get storyFormat(): string | undefined {
    this.ensureCurrent();
    return this.format.name;
  }

  /**
   * Whether Spindle semantics apply to this project. False only if a
   * StoryData passage names another story format (SugarCube, Harlowe, ...)
   * and none names Spindle; a missing or unreadable StoryData counts as
   * Spindle.
   */
  isSpindleProject(): boolean {
    this.ensureCurrent();
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

  /** Index local headers immediately; defer expensive cross-document analysis. */
  private handleDocumentChange(uri: string): void {
    const text = this.documents.getText(uri);
    // JS/TS macro sources only feed macro discovery — they hold no passages
    if (text !== undefined && !isMacroSource(uri)) {
      this.passages.rebuild(uri, text);
    }
    this.analysisPending = true;
    this.updateStoryFormat();
    this.emit('documentChanged', uri);
    this.emit('passagesUpdated', uri);
    this.scheduleModelReady();
  }

  /** Remove local indices immediately and schedule cross-document analysis. */
  private handleDocumentClose(uri: string): void {
    this.passages.remove(uri);
    this._variables.removeDocument(uri);
    this.analysisPending = true;
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
    this.analysisPending = true;
    this.ensureCurrent();
  }

  /** Finish pending cross-document work once, before a feature reads the indices. */
  ensureCurrent(): void {
    if (!this.analysisPending) return;
    // Internal reads during the cascade must not recursively start another one.
    this.analysisPending = false;
    this.refreshDiscoveredMacros();
    this.cascade();
    this.updateStoryFormat();
  }

  /**
   * Re-read the story format from the StoryData passages after the passage
   * index changed, emitting 'storyFormatChanged' if it differs. Listeners
   * that read the analysis indices finish pending analysis through getters.
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
    const init: Passage[] = [];
    const seen = new Set<string>();
    const effective = new Map(this.passages.getEffectivePassages().map(passage => [passage.name, passage]));

    // Use a stable source order within each runtime phase.
    for (const uri of this.documents.getUris().sort(compareSourceUris)) {
      const text = this.documents.getText(uri);
      if (!text) continue;

      if (isMacroSource(uri)) {
        found.push(...discoverMacros(text));
        continue;
      }

      for (const source of this.passages.getPassagesInDocument(uri)) {
        // Replacement keeps the first passage's compiler slot, including its
        // position relative to standalone JavaScript sources.
        if (seen.has(source.name)) continue;
        seen.add(source.name);
        const passage = effective.get(source.name)!;
        if (passage.tags?.includes('Twine.private')) continue;
        const isStoryInit = passage.name === 'StoryInit' && isRuntimePassage(passage);
        const isScript = passage.tags?.includes('script') ?? false;
        if (!isStoryInit && !isScript) continue;

        const content = this.markup.get(passage.uri)?.passages.find(p => p.passage === passage)?.content ?? '';
        if (isScript) found.push(...discoverMacros(content));
        else init.push(passage);
      }
    }

    // Story JavaScript and widget registration precede StoryInit. Read its
    // executable pieces only after dropping stale discoveries and installing
    // that phase's metadata, including the provenance of replaced macros.
    this.macros.setDiscoveredMacros(found);
    if (init.length === 0) return;
    this.rescanWidgets();
    for (const passage of init) {
      const markup = this.markup.get(passage.uri)?.passages.find(p => p.passage === passage);
      if (markup) found.push(...storyInitMacros(markup));
    }
    this.macros.setDiscoveredMacros(found);
  }

  /**
   * Cascade: rescan variables and widgets based on current passages.
   * Called after any passage index update.
   *
   * The markup of every document is read again (the macros may have changed),
   * the widgets are defined from it, and then the variable usages and widget
   * invocations are read from the same markup, which pairs its tags with the
   * widgets just defined.
   */
  private cascade(): void {
    this.markup.invalidate();

    // The target version only decides whether to warn
    this.declaredVersion = storyDataFormatVersion(this.passages.getAllPassages(), (uri) => this.documents.getText(uri));
    this._target = resolveSpindleTarget(this.installedVersion, this.declaredVersion);

    // Declarations use the indexed passage body, including compact boundaries.
    const declarations = (name: string) => {
      const passage = this.passages.getEffectivePassage(name);
      return passage && isRuntimePassage(passage) ? this.markup.get(passage.uri)?.passages.find(p => p.passage === passage) : undefined;
    };
    const variables = declarations('StoryVariables');
    if (variables) this.variables.parseStoryVariables(variables.content, variables.passage.headerEnd.end.line + 1, variables.doc.uri);
    else this.variables.clearStoryVariables();
    const transients = declarations('StoryTransients');
    if (transients) this.variables.parseStoryTransients(transients.content, transients.passage.headerEnd.end.line + 1, transients.doc.uri);
    else this.variables.clearStoryTransients();

    // Rescan widgets: the markup pairs its tags with them once they are known
    this.rescanWidgets();

    // Rescan variable usages and widget invocations across all story documents
    // (empty documents are scanned too, dropping their previous usages)
    const effective = new Set(this.passages.getEffectivePassages());
    this.widgets.clearInvocations();
    for (const doc of this.readDocuments()) {
      const passages = doc.passages.filter(p => effective.has(p.passage));
      this.variables.scanDocument(doc.uri, doc.text, { passages });
      this.widgets.recordInvocations(doc.uri, passages);
    }
  }

  /** The story documents' markup; JavaScript/TypeScript sources hold no passages. */
  private readDocuments() {
    return this.documents.getUris().flatMap(uri => {
      const markup = isMacroSource(uri) ? undefined : this.markup.get(uri);
      return markup ? [markup] : [];
    });
  }

  /** Refresh widget registration before executable analysis reads its metadata. */
  private rescanWidgets(): void {
    const markups = new Map<Passage, PassageMarkup>();
    for (const doc of this.readDocuments()) for (const passage of doc.passages) markups.set(passage.passage, passage);
    const effective = new Set(this.passages.getEffectivePassages());
    this.widgets.scan(
      [...effective].flatMap((passage) => markups.get(passage) ?? []),
      this.macros.toolingMacros(),
      [...markups].filter(([passage]) => !effective.has(passage)).map(([, markup]) => markup),
    );

    // Discard the discovery context (which can contain definitions from the
    // previous scan) before any usage/code/pairing analysis is cached.
    this.markup.invalidate();
  }

  /** All runtime metadata, with effective widgets taking precedence over macros. */
  private toolingMacros() {
    const macros = this.macros.toolingMacros().filter(macro => !this.widgets.getEffectiveWidget(macro.name));
    return [...macros, ...this.widgets.getAllWidgets()
      .map(widget => ({ name: widget.name, block: widget.block || this.macros.isBlock(widget.name), subMacros: [], widget: widget.tooling }))];
  }

  /** Coalesce analysis and diagnostics across a burst of document changes. */
  private scheduleModelReady(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.ensureCurrent();
      this.emit('modelReady');
    }, this.DEBOUNCE_MS);
  }
}
