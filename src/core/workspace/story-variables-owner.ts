import { isMacroSource } from './macro-sources.js';
import type { WorkspaceModel } from './workspace-model.js';

/**
 * The one document that carries the workspace-wide SP202 (no StoryVariables
 * passage) and receives its "Create StoryVariables passage" quick fix: the
 * first story document, in workspace order, that holds a passage.
 *
 * A story document is what the workspace model indexes and the diagnostics
 * plugin publishes for: any non-JS/TS document (the extension is not
 * restricted: an unsaved `untitled:` buffer or an editor-associated `.tw2`
 * is analysed like `.tw`/`.twee`). The story format is read from StoryData
 * passages of those same documents, so a declared Spindle story always has an
 * owner (a document with a StoryData passage has a passage).
 * Diagnostic and quick fix both use this, so applying the fix always lands in
 * the document that reported the problem.
 */
export function missingStoryVariablesOwner(workspace: WorkspaceModel): string | undefined {
  return workspace.documents.getUris().find(
    u => !isMacroSource(u)
      && workspace.passages.getPassagesInDocument(u).length > 0,
  );
}
