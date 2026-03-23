type Prettier = typeof import('prettier');

let prettier: Prettier | null = null;
let prettierLoaded = false;

async function loadPrettier(): Promise<Prettier | null> {
  if (prettierLoaded) return prettier;
  prettierLoaded = true;
  try {
    prettier = await import('prettier');
  } catch {
    prettier = null;
  }
  return prettier;
}

export async function isPrettierAvailable(): Promise<boolean> {
  return (await loadPrettier()) !== null;
}

async function getBaseConfig(): Promise<Record<string, unknown>> {
  const p = await loadPrettier();
  if (!p) return {};
  try {
    const resolved = await p.resolveConfig(process.cwd());
    return { tabWidth: 2, ...(resolved ?? {}) };
  } catch {
    return { tabWidth: 2 };
  }
}

export async function formatJS(code: string): Promise<string> {
  const p = await loadPrettier();
  if (!p) return code;
  try {
    const config = await getBaseConfig();
    return await p.format(code, { ...config, parser: 'babel' });
  } catch {
    return code;
  }
}

export async function formatCSS(code: string): Promise<string> {
  const p = await loadPrettier();
  if (!p) return code;
  try {
    const config = await getBaseConfig();
    return await p.format(code, { ...config, parser: 'css' });
  } catch {
    return code;
  }
}

export async function formatHTML(code: string): Promise<string> {
  const p = await loadPrettier();
  if (!p) return code;
  try {
    const config = await getBaseConfig();
    return await p.format(code, {
      ...config,
      parser: 'html',
      htmlWhitespaceSensitivity: 'ignore',
    });
  } catch {
    return code;
  }
}
