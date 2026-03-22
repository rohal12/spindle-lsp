export interface DiscoveredMacro {
  name: string;
  block?: boolean;
  subMacros?: string[];
  storeVar?: boolean;
  merged?: boolean;
  interpolate?: boolean;
  description?: string;
}

/**
 * Regex to locate Story.defineMacro({ call sites.
 */
const defineMacroRegex = /Story\.defineMacro\s*\(\s*\{/g;

/**
 * Extract the balanced brace-delimited config object starting from
 * the opening '{' at position `start` in `source`.
 * Returns the substring including both braces, or null if unbalanced.
 */
function extractBalancedBraces(source: string, start: number): string | null {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const prev = i > start ? source[i - 1] : '';

    // Handle escape sequences inside strings
    if (prev === '\\') continue;

    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
    } else if (ch === '"') {
      inDoubleQuote = true;
    } else if (ch === '`') {
      inBacktick = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Parse static fields from a config object string using regexes.
 */
function parseConfigFields(config: string): DiscoveredMacro | null {
  // Extract name (required)
  const nameMatch = config.match(/name:\s*['"]([^'"]+)['"]/);
  if (!nameMatch) return null;

  const macro: DiscoveredMacro = {
    name: nameMatch[1],
  };

  // Boolean fields
  const boolFields: Array<'block' | 'storeVar' | 'merged' | 'interpolate'> = [
    'block', 'storeVar', 'merged', 'interpolate',
  ];

  for (const field of boolFields) {
    const re = new RegExp(`${field}:\\s*(true|false)`);
    const m = config.match(re);
    if (m) {
      macro[field] = m[1] === 'true';
    }
  }

  // description
  const descMatch = config.match(/description:\s*['"]([^'"]+)['"]/);
  if (descMatch) {
    macro.description = descMatch[1];
  }

  // subMacros
  const subMatch = config.match(/subMacros:\s*\[([^\]]*)\]/);
  if (subMatch) {
    const inner = subMatch[1].trim();
    if (inner) {
      macro.subMacros = inner.split(',').map(s =>
        s.trim().replace(/^['"]|['"]$/g, '')
      ).filter(s => s.length > 0);
    }
  }

  return macro;
}

/**
 * Discover macro definitions from JS/TS source code that contains
 * Story.defineMacro({...}) calls.
 */
export function discoverMacrosFromSource(source: string): DiscoveredMacro[] {
  const macros: DiscoveredMacro[] = [];

  defineMacroRegex.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = defineMacroRegex.exec(source)) !== null) {
    // The '{' is at match.index + match[0].length - 1
    const braceStart = match.index + match[0].length - 1;
    const config = extractBalancedBraces(source, braceStart);
    if (!config) continue;

    const macro = parseConfigFields(config);
    if (macro) {
      macros.push(macro);
    }
  }

  return macros;
}

/**
 * Regex to extract content between {do} and {/do} blocks in passage text.
 */
const doBlockRegex = /\{do\}([\s\S]*?)\{\/do\}/g;

/**
 * Discover macro definitions from StoryInit passage content.
 * Looks inside {do}...{/do} blocks for Story.defineMacro() calls.
 */
export function discoverMacrosFromStoryInit(passageContent: string): DiscoveredMacro[] {
  const macros: DiscoveredMacro[] = [];

  doBlockRegex.lastIndex = 0;
  let doMatch: RegExpExecArray | null;

  while ((doMatch = doBlockRegex.exec(passageContent)) !== null) {
    const jsContent = doMatch[1];
    const found = discoverMacrosFromSource(jsContent);
    macros.push(...found);
  }

  return macros;
}
