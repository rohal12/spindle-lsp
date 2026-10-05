import { readFileSync } from 'node:fs';
import type { Passage } from '../types.js';
import { PassageIndex } from './passage-index.js';
import { findProjectFiles, findProjectRoot } from './macro-sources.js';
import { readInstalledSpindleVersion, resolveSpindleCapabilities } from './spindle-capabilities.js';
import type { SpindleCapabilities } from './spindle-capabilities.js';

/**
 * The story format a project declares in its Twee 3 StoryData passage
 * (`"format": "spindle"`). spindle-lsp applies Spindle semantics only to
 * Spindle projects: a SugarCube story's `<</if>>` is not a broken HTML tag.
 */
export interface StoryFormat {
  /**
   * The format named by StoryData (trimmed): the Spindle entry if one names
   * Spindle, otherwise the first other format. Undefined if no StoryData
   * passage names a format.
   */
  name: string | undefined;
  /**
   * False only if a StoryData passage names another format and none names
   * Spindle. A missing StoryData, a missing `format` field or JSON that does
   * not parse leave the project a Spindle project, so a Spindle story is
   * never silenced by accident.
   */
  isSpindle: boolean;
}

/** A Spindle project without a declared format: the default. */
export const UNDECLARED_STORY_FORMAT: StoryFormat = { name: undefined, isSpindle: true };

/** Whether a declared format name names Spindle (case-insensitive, trimmed). */
export function isSpindleFormatName(name: string): boolean {
  return name.trim().toLowerCase() === 'spindle';
}

/**
 * The `format` field of a StoryData passage's JSON content, trimmed.
 * Undefined if the content does not parse as a JSON object or its `format`
 * is missing, not a string, or blank.
 */
export function readStoryDataFormat(content: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const format = (data as Record<string, unknown>).format;
  if (typeof format !== 'string') return undefined;
  return format.trim() || undefined;
}

/**
 * The `format-version` of a StoryData passage's JSON content, trimmed, for
 * a StoryData that names Spindle or no format. Undefined if the content does
 * not parse, names another format, or has no string `format-version`.
 */
export function readStoryDataFormatVersion(content: string): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.format === 'string' && record.format.trim() && !isSpindleFormatName(record.format)) {
    return undefined;
  }
  const version = record['format-version'];
  return typeof version === 'string' && version.trim() ? version.trim() : undefined;
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
  return text
    .split('\n')
    .slice(passage.headerEnd.end.line + 1, passage.range.end.line + 1)
    .join('\n');
}

/**
 * The formats declared by the StoryData passages among `passages`
 * (undefined for one that names none). `getText` returns a passage's
 * document text.
 */
export function storyDataFormats(
  passages: Iterable<Passage>,
  getText: (uri: string) => string | undefined,
): Array<string | undefined> {
  const formats: Array<string | undefined> = [];
  for (const passage of passages) {
    if (passage.name !== 'StoryData') continue;
    const text = getText(passage.uri);
    formats.push(text === undefined ? undefined : readStoryDataFormat(passageContent(passage, text)));
  }
  return formats;
}

/** The first `format-version` declared by a Spindle StoryData passage among `passages`. */
export function storyDataFormatVersion(
  passages: Iterable<Passage>,
  getText: (uri: string) => string | undefined,
): string | undefined {
  for (const passage of passages) {
    if (passage.name !== 'StoryData') continue;
    const text = getText(passage.uri);
    if (text === undefined) continue;
    const version = readStoryDataFormatVersion(passageContent(passage, text));
    if (version !== undefined) return version;
  }
  return undefined;
}

/**
 * The story format declared in a set of documents, without a workspace,
 * and whether any of them has a StoryData passage at all.
 */
export function storyFormatOfTexts(
  texts: Iterable<string>,
): StoryFormat & { hasStoryData: boolean } {
  const index = new PassageIndex();
  const byUri = new Map<string, string>();
  for (const text of texts) {
    // Skip the header parse for documents that cannot hold StoryData
    if (!text.includes('StoryData')) continue;
    const uri = `story-format:${byUri.size}`;
    byUri.set(uri, text);
    index.rebuild(uri, text);
  }
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
  const own = storyFormatOfTexts(texts);
  if (own.hasStoryData) return { name: own.name, isSpindle: own.isSpindle };

  const projectTexts: string[] = [];
  for (const file of await findProjectFiles(findProjectRoot(dir), '**/*.{tw,twee}')) {
    try {
      projectTexts.push(readFileSync(file, 'utf-8'));
    } catch {
      // Skip unreadable files
    }
  }
  const { name, isSpindle } = storyFormatOfTexts(projectTexts);
  return { name, isSpindle };
}

/** The first `format-version` a Spindle StoryData among `texts` declares. */
function storyFormatVersionOfTexts(texts: Iterable<string>): string | undefined {
  const index = new PassageIndex();
  const byUri = new Map<string, string>();
  for (const text of texts) {
    if (!text.includes('StoryData')) continue;
    const uri = `story-format:${byUri.size}`;
    byUri.set(uri, text);
    index.rebuild(uri, text);
  }
  return storyDataFormatVersion(index.getAllPassages(), uri => byUri.get(uri));
}

/**
 * The target Spindle of files processed without a workspace (the CLI and MCP
 * formatter), resolved like the workspace does: the `@rohal12/spindle`
 * installed at or above `dir`, else the `format-version` of a StoryData among
 * `texts` or in the project containing `dir`, else the default behavior.
 */
export async function findSpindleCapabilities(texts: Iterable<string>, dir: string): Promise<SpindleCapabilities> {
  const installed = readInstalledSpindleVersion(dir);
  if (installed) return resolveSpindleCapabilities(installed);
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
  return resolveSpindleCapabilities(undefined, version);
}

/** Note shown by the CLI and MCP tools when they skip a non-Spindle project. */
export function skippedFormatNote(format: StoryFormat): string {
  return `Skipped: story format is ${format.name}, not Spindle`;
}
