import type { Connection } from 'vscode-languageserver';

/**
 * Request registrations a plugin may make through the gated connection.
 * Every request listed here has `null` as a valid LSP result:
 *
 *  - completion:        CompletionItem[] | CompletionList | null
 *  - hover:             Hover | null
 *  - signatureHelp:     SignatureHelp | null
 *  - definition:        Location | Location[] | LocationLink[] | null
 *  - references:        Location[] | null
 *  - prepareRename:     Range | { range, placeholder } | { defaultBehavior } | null
 *  - rename:            WorkspaceEdit | null
 *  - codeLens:          CodeLens[] | null
 *  - codeAction:        (Command | CodeAction)[] | null
 *  - formatting:        TextEdit[] | null
 *  - rangeFormatting:   TextEdit[] | null
 *  - documentSymbol:    DocumentSymbol[] | SymbolInformation[] | null
 *  - workspace/symbol:  SymbolInformation[] | WorkspaceSymbol[] | null
 *  - foldingRange:      FoldingRange[] | null
 *  - documentLink:      DocumentLink[] | null
 *  - semanticTokens/full: SemanticTokens | null
 *  - inlayHint:         InlayHint[] | null
 *
 * Resolve requests (completionItem/resolve, codeLens/resolve, ...) must
 * return their item and so cannot be gated this way; none is registered.
 */
const GATED_REQUESTS = [
  'onCompletion',
  'onHover',
  'onSignatureHelp',
  'onDefinition',
  'onReferences',
  'onPrepareRename',
  'onRenameRequest',
  'onCodeLens',
  'onCodeAction',
  'onDocumentFormatting',
  'onDocumentRangeFormatting',
  'onDocumentSymbol',
  'onWorkspaceSymbol',
  'onFoldingRanges',
  'onDocumentLinks',
] as const;

/** Gated registrations on `connection.languages.<feature>`. */
const GATED_LANGUAGE_FEATURES: Record<string, readonly string[]> = {
  semanticTokens: ['on'],
  inlayHint: ['on'],
};

type Handler = (...args: unknown[]) => unknown;

/**
 * A view of `target` whose `methods` register their handler (the first
 * argument) wrapped so that it answers `null` while `enabled()` is false.
 * Everything else passes through to `target`.
 */
function gateRegistrations<T extends object>(
  target: T,
  methods: readonly string[],
  enabled: () => boolean,
  nested: Record<string, (value: object) => object> = {},
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof prop !== 'string') return value;
      if (Object.hasOwn(nested, prop) && value !== null && (typeof value === 'object' || typeof value === 'function')) {
        return nested[prop](value);
      }
      if (methods.includes(prop) && typeof value === 'function') {
        return (handler: Handler, ...rest: unknown[]) =>
          Reflect.apply(value as Handler, obj, [
            (...args: unknown[]) => (enabled() ? handler(...args) : null),
            ...rest,
          ]);
      }
      return value;
    },
  });
}

/**
 * Wrap the connection handed to plugins so that every language feature
 * request answers `null` while `enabled()` is false (the workspace's
 * StoryData names a story format other than Spindle). This is the single
 * gate for all request-based features; diagnostics, which the server pushes
 * rather than answers, are gated in computeDiagnostics().
 *
 * Plugins may register only the requests in {@link GATED_REQUESTS} and
 * {@link GATED_LANGUAGE_FEATURES}; a test runs every plugin against a
 * disabled gate to keep it that way.
 */
export function gateConnection(connection: Connection, enabled: () => boolean): Connection {
  const languageFeatures: Record<string, (value: object) => object> = {};
  for (const [feature, methods] of Object.entries(GATED_LANGUAGE_FEATURES)) {
    languageFeatures[feature] = value => gateRegistrations(value, methods, enabled);
  }
  return gateRegistrations(connection, GATED_REQUESTS, enabled, {
    languages: value => gateRegistrations(value, [], enabled, languageFeatures),
  });
}
