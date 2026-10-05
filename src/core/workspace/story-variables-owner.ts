import { isMacroSource } from './macro-sources.js';
import type { WorkspaceModel } from './workspace-model.js';

/**
 * The one document that carries the workspace-wide SP202 (no StoryVariables
 * passage) and receives its "Create StoryVariables passage" quick fix: the
 * first Twee story document, in workspace order, that holds a passage.
 * Diagnostic and quick fix both use this, so applying the fix always lands in
 * the document that reported the problem.
 */
export function missingStoryVariablesOwner(workspace: WorkspaceModel): string | undefined {
  return workspace.documents.getUris().find(
    u => /\.(tw|twee)$/i.test(u)
      && !isMacroSource(u)
      && workspace.passages.getPassagesInDocument(u).length > 0,
  );
}
