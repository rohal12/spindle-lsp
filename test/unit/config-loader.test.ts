import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfigFromDisk, findConfigFile } from '../../src/core/workspace/config-loader.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('parseConfig', () => {
  it('parses YAML with macros', () => {
    const yaml = `
macros:
  dialog:
    block: true
    subMacros:
      - say
  say:
    block: false
`;
    const result = parseConfig(yaml, 'yaml');
    expect(result.macros).toBeDefined();
    expect(result.macros.dialog).toEqual({ block: true, subMacros: ['say'] });
    expect(result.macros.say).toEqual({ block: false });
  });

  it('parses JSON with macros', () => {
    const json = JSON.stringify({
      macros: {
        popup: { block: true, subMacros: [] },
      },
    });
    const result = parseConfig(json, 'json');
    expect(result.macros.popup).toEqual({ block: true, subMacros: [] });
  });

  it('returns empty macros for empty content', () => {
    const result = parseConfig('', 'yaml');
    expect(result.macros).toEqual({});
  });

  it('returns empty macros for content without macros key', () => {
    const result = parseConfig('other: value', 'yaml');
    expect(result.macros).toEqual({});
  });

  it('returns empty macros for non-object YAML', () => {
    const result = parseConfig('42', 'yaml');
    expect(result.macros).toEqual({});
  });
});

describe('findConfigFile', () => {
  it('finds spindle.config.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-test-'));
    try {
      writeFileSync(join(dir, 'spindle.config.yaml'), 'macros: {}');
      const result = findConfigFile(dir);
      expect(result).toBe(join(dir, 'spindle.config.yaml'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('finds spindle.config.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-test-'));
    try {
      writeFileSync(join(dir, 'spindle.config.yml'), 'macros: {}');
      const result = findConfigFile(dir);
      expect(result).toBe(join(dir, 'spindle.config.yml'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('finds spindle.config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-test-'));
    try {
      writeFileSync(join(dir, 'spindle.config.json'), '{"macros":{}}');
      const result = findConfigFile(dir);
      expect(result).toBe(join(dir, 'spindle.config.json'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('prefers yaml over yml over json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-test-'));
    try {
      writeFileSync(join(dir, 'spindle.config.yaml'), 'macros: {}');
      writeFileSync(join(dir, 'spindle.config.yml'), 'macros: {}');
      writeFileSync(join(dir, 'spindle.config.json'), '{"macros":{}}');
      const result = findConfigFile(dir);
      expect(result).toBe(join(dir, 'spindle.config.yaml'));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('returns null when no config file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-test-'));
    try {
      const result = findConfigFile(dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('loadConfigFromDisk', () => {
  it('returns empty config when no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-test-'));
    try {
      const result = loadConfigFromDisk(dir);
      expect(result).toEqual({ macros: {} });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('loads and parses a YAML config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-test-'));
    try {
      writeFileSync(join(dir, 'spindle.config.yaml'), 'macros:\n  test:\n    block: true\n');
      const result = loadConfigFromDisk(dir);
      expect(result.macros.test).toEqual({ block: true });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('loads and parses a JSON config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spindle-test-'));
    try {
      writeFileSync(join(dir, 'spindle.config.json'), '{"macros":{"test":{"block":false}}}');
      const result = loadConfigFromDisk(dir);
      expect(result.macros.test).toEqual({ block: false });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
