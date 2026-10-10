import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'glob';

import { formatDocument } from '../plugins/format.js';
import { commonDirectory } from '../core/workspace/macro-sources.js';
import { findSpindleTarget, findStoryFormat, skippedFormatNote } from '../core/workspace/story-format.js';
import { unsupportedVersionMessage } from '../core/workspace/spindle-version.js';
import type { FormatOptions as FormatDocOptions } from '../plugins/format.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface FormatOptions {
  check: boolean;
  maxLineLength: number | null;
  patterns: string[];
}

function parseArgs(args: string[]): FormatOptions {
  const options: FormatOptions = {
    check: false,
    maxLineLength: null,
    patterns: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--check') {
      options.check = true;
      i++;
    } else if (arg === '--max-line-length' && i + 1 < args.length) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) options.maxLineLength = n;
      i += 2;
    } else if (arg.startsWith('--max-line-length=')) {
      const n = parseInt(arg.slice('--max-line-length='.length), 10);
      if (!isNaN(n) && n > 0) options.maxLineLength = n;
      i++;
    } else if (!arg.startsWith('--')) {
      options.patterns.push(arg);
      i++;
    } else {
      i++;
    }
  }

  if (options.patterns.length === 0) {
    options.patterns = ['**/*.{tw,twee}'];
  }

  return options;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runFormat(args: string[]): Promise<number> {
  const options = parseArgs(args);
  const cwd = process.cwd();

  // Resolve files via glob
  const files: string[] = [];
  for (const pattern of options.patterns) {
    const matches = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
    });
    files.push(...matches);
  }

  const uniqueFiles = [...new Set(files)];

  if (uniqueFiles.length === 0) {
    console.log('No files found');
    return 0;
  }

  // Leave a story in another format alone: Spindle's formatting rules
  // could corrupt it. Its StoryData is among the files or in their project.
  const texts = new Map<string, string>();
  for (const filePath of uniqueFiles) {
    try {
      texts.set(filePath, readFileSync(filePath, 'utf-8'));
    } catch {
      // Skip unreadable files
    }
  }
  const storyFormat = await findStoryFormat(texts.values(), commonDirectory(uniqueFiles));
  if (!storyFormat.isSpindle) {
    console.error(skippedFormatNote(storyFormat));
    return 0;
  }

  // Spindle reads the markup by the rules of its release: say so when the
  // project's is older than the one this formatter follows
  const target = await findSpindleTarget(texts.values(), commonDirectory(uniqueFiles));
  if (!target.supported) console.error(`Warning: ${unsupportedVersionMessage(target)}`);

  const formatOpts: FormatDocOptions = {};
  if (options.maxLineLength !== null) {
    formatOpts.maxLineLength = options.maxLineLength;
  }

  const unformatted: string[] = [];

  for (const [filePath, text] of texts) {
    try {
      const formatted = await formatDocument(text, formatOpts);

      if (formatted !== text) {
        if (options.check) {
          const relative = filePath.startsWith(cwd)
            ? filePath.slice(cwd.length + 1)
            : filePath;
          unformatted.push(relative);
        } else {
          writeFileSync(filePath, formatted, 'utf-8');
        }
      }
    } catch {
      // Skip unwritable files
    }
  }

  if (options.check) {
    if (unformatted.length > 0) {
      for (const file of unformatted) {
        console.log(file);
      }
      console.log(`\n${unformatted.length} file${unformatted.length !== 1 ? 's' : ''} would be reformatted`);
      return 1;
    }
    return 0;
  }

  return 0;
}
