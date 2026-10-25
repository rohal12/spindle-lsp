import { splitLines } from '../text.js';
import { readFileSync } from 'node:fs';
import { stripBom } from './document-store.js';
import type { Passage } from '../types.js';
import { PassageIndex } from './passage-index.js';
import { readStoryData } from './story-data.js';
import { findProjectFiles, findProjectRoot } from './macro-sources.js';
import { readInstalledSpindleVersion, resolveSpindleTarget } from './spindle-version.js';
import type { SpindleTarget } from './spindle-version.js';

/**
 * The story format a project declares in its Twee 3 StoryData passage
 * (`"format": "spindle"`). spindle-lsp applies Spindle semantics only to
 * Spindle projects: a SugarCube story's `<</if>>` is not a broken HTML tag.
 */
export interface StoryFormat {
  /**
   * The format named by the compiler-effective StoryData, trimmed.
   * Undefined if that passage names no format.
   */
  name: string | undefined;
  /**
   * False only if the effective StoryData names another format.
   * A missing StoryData, a missing `format` field or JSON that does
   * not parse leave the project a Spindle project, so a Spindle story is
   * never silenced by accident.
   */
  isSpindle: boolean;
}

/** A Spindle project without a declared format: the default. */
export const UNDECLARED_STORY_FORMAT: StoryFormat = { name: undefined, isSpindle: true };

/** Whether a declared format name names Spindle (case-insensitive, trimmed). */
function isSpindleFormatName(name: string): boolean {
  return name.trim().toLowerCase() === 'spindle';
}

/**
 * The compiler's effective `format` for a StoryData passage, trimmed.
 * Undefined if the content is not a JSON object or the compiler reads no
 * nonblank format. Repeated fields and nulls follow the compiler's decoder.
 */
export function readStoryDataFormat(content: string): string | undefined {
  return readStoryData(content).format.trim() || undefined;
}

/**
 * The compiler's effective `format-version`, trimmed, for a StoryData that
 * names Spindle or no format. Undefined if the compiler reads no version
 * or the effective format names another story format.
 */
function readStoryDataFormatVersion(content: string): string | undefined {
  const metadata = readStoryData(content);
  if (metadata.format.trim() && !isSpindleFormatName(metadata.format)) {
    return undefined;
  }
  return metadata.formatVersion.trim() || undefined;
}

/**
 * Combine the formats declared by every StoryData passage (undefined for
 * one that names none): Spindle if any names Spindle, foreign if one names
 * another format, Spindle otherwise.
 */
export function resolveStoryFormat(declared: Iterable<string | undefined>): StoryFormat {
  let foreign: string | undefined;
  for (const name of declared) {
    if (name === undefined) continue;
    if (isSpindleFormatName(name)) return { name: name.trim(), isSpindle: true };
    foreign ??= name.trim();
  }
  return foreign === undefined ? UNDECLARED_STORY_FORMAT : { name: foreign, isSpindle: false };
}

/** The content (lines after the header) of a passage in its document's text. */
function passageContent(passage: Passage, text: string): string {
  return splitLines(text)
    .slice(passage.headerEnd.end.line + 1, passage.range.end.line + 1)
    .join('\n');
}

/** StoryData replacement follows compiler source order, including missing fields. */
function effectiveStoryData(passages: Iterable<Passage>): Passage[] {
  const passage = [...passages].filter(p => p.name === 'StoryData').at(-1);
  return passage ? [passage] : [];
}

/**
 * The effective StoryData's format (undefined if it names none).
 * `passages` follows compiler source order; `getText` returns document text.
 */
export function storyDataFormats(
  passages: Iterable<Passage>,
  getText: (uri: string) => string | undefined,
): Array<string | undefined> {
  const formats: Array<string | undefined> = [];
  for (const passage of effectiveStoryData(passages)) {
    const text = getText(passage.uri);
    formats.push(text === undefined ? undefined : readStoryDataFormat(passageContent(passage, text)));
  }
  return formats;
}

/** The effective `format-version` declared by a Spindle StoryData passage among `passages`. */
export function storyDataFormatVersion(
  passages: Iterable<Passage>,
  getText: (uri: string) => string | undefined,
): string | undefined {
  for (const passage of effectiveStoryData(passages)) {
    const text = getText(passage.uri);
    if (text === undefined) continue;
    const version = readStoryDataFormatVersion(passageContent(passage, text));
    if (version !== undefined) return version;
  }
  return undefined;
}

/** Index in input order, even when there are more than ten source documents. */
function indexStoryDataTexts(texts: Iterable<string>) {
  const index = new PassageIndex();
  const byUri = new Map<string, string>();
  for (const text of texts) {
    // Skip the header parse for documents that cannot hold StoryData
    if (!text.includes('StoryData')) continue;
    const uri = `story-format:${String(byUri.size).padStart(16, '0')}`;
    byUri.set(uri, text);
    index.rebuild(uri, text);
  }
  return { index, byUri };
}

/**
 * The story format declared in a set of documents, without a workspace,
 * and whether any of them has a StoryData passage at all.
 */
export function storyFormatOfTexts(
  texts: Iterable<string>,
): StoryFormat & { hasStoryData: boolean } {
  const { index, byUri } = indexStoryDataTexts(texts);
  const formats = storyDataFormats(index.getAllPassages(), uri => byUri.get(uri));
  return { ...resolveStoryFormat(formats), hasStoryData: formats.length > 0 };
}

/**
 * The story format of a set of files processed without a workspace
 * (`texts`, from the directory `dir`): their own StoryData if one of them
 * has it, otherwise that of the Twee files in the project containing `dir`
 * (found like the project's macro sources, skipping dependencies, build
 * output and hidden directories).
 */
export async function findStoryFormat(texts: Iterable<string>, dir: string): Promise<StoryFormat> {
  const own = storyFormatOfTexts([...texts].map(stripBom));
  if (own.hasStoryData) return { name: own.name, isSpindle: own.isSpindle };

  const projectTexts: string[] = [];
  for (const file of await findProjectFiles(findProjectRoot(dir), '**/*.{tw,twee}')) {
    try {
      projectTexts.push(stripBom(readFileSync(file, 'utf-8')));
    } catch {
      // Skip unreadable files
    }
  }
  const { name, isSpindle } = storyFormatOfTexts(projectTexts);
  return { name, isSpindle };
}

/** The effective `format-version` a Spindle StoryData among `texts` declares. */
function storyFormatVersionOfTexts(texts: Iterable<string>): string | undefined {
  const { index, byUri } = indexStoryDataTexts(texts);
  return storyDataFormatVersion(index.getAllPassages(), uri => byUri.get(uri));
}

/**
 * The target Spindle of files processed without a workspace (the CLI and MCP
 * formatter), resolved like the workspace does: the `@rohal12/spindle`
 * installed at or above `dir`, else the `format-version` of a StoryData among
 * `texts` or in the project containing `dir`, else none. Only used to tell
 * the user when it is older than the oldest supported release.
 */
export async function findSpindleTarget(texts: Iterable<string>, dir: string): Promise<SpindleTarget> {
  const installed = readInstalledSpindleVersion(dir);
  if (installed) return resolveSpindleTarget(installed);
  const own = [...texts];
  let version = storyFormatVersionOfTexts(own);
  if (version === undefined && !storyFormatOfTexts(own).hasStoryData) {
    const projectTexts: string[] = [];
    for (const file of await findProjectFiles(findProjectRoot(dir), '**/*.{tw,twee}')) {
      try {
        projectTexts.push(readFileSync(file, 'utf-8'));
      } catch {
        // Skip unreadable files
      }
    }
    version = storyFormatVersionOfTexts(projectTexts);
  }
  return resolveSpindleTarget(undefined, version);
}

/** Note shown by the CLI and MCP tools when they skip a non-Spindle project. */
export function skippedFormatNote(format: StoryFormat): string {
  return `Skipped: story format is ${format.name}, not Spindle`;
}
