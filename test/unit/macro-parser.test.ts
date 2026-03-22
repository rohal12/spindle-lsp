import { describe, it, expect } from 'vitest';
import { parseMacros, pairMacros } from '../../src/core/parsing/macro-parser.js';

describe('parseMacros', () => {
  it('parses simple macro', () => {
    const macros = parseMacros('{set $x = 1}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('set');
    expect(macros[0].open).toBe(true);
    expect(macros[0].rawArgs).toBe('$x = 1');
  });

  it('parses closing macro', () => {
    const macros = parseMacros('{/if}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('if');
    expect(macros[0].open).toBe(false);
  });

  it('parses CSS prefix', () => {
    const macros = parseMacros('{.red#alert button "Click"}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('button');
    expect(macros[0].cssPrefix).toBe('.red#alert');
    expect(macros[0].rawArgs).toBe('"Click"');
  });

  it('skips variable interpolation', () => {
    const macros = parseMacros('{$health}');
    expect(macros).toHaveLength(0);
  });

  it('skips _ variable interpolation', () => {
    const macros = parseMacros('{_temp}');
    expect(macros).toHaveLength(0);
  });

  it('skips @ variable interpolation', () => {
    const macros = parseMacros('{@local}');
    expect(macros).toHaveLength(0);
  });

  it('skips escaped braces', () => {
    const macros = parseMacros('\\{not a macro\\}');
    expect(macros).toHaveLength(0);
  });

  it('parses multiple macros', () => {
    const macros = parseMacros('{if $x}{set $y = 1}{/if}');
    expect(macros).toHaveLength(3);
    expect(macros[0].name).toBe('if');
    expect(macros[1].name).toBe('set');
    expect(macros[2].name).toBe('if');
    expect(macros[2].open).toBe(false);
  });

  it('handles multi-line text with correct positions', () => {
    const text = 'line 0\n{set $x = 1}\nline 2';
    const macros = parseMacros(text);
    expect(macros).toHaveLength(1);
    expect(macros[0].range.start.line).toBe(1);
    expect(macros[0].range.start.character).toBe(0);
  });

  it('parses macro with string args containing braces', () => {
    const macros = parseMacros('{link "text" "passage"}');
    expect(macros).toHaveLength(1);
    expect(macros[0].rawArgs).toBe('"text" "passage"');
  });

  it('parses macro with no args', () => {
    const macros = parseMacros('{back}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('back');
    expect(macros[0].rawArgs).toBeUndefined();
  });

  it('handles variable interpolation mixed with macros', () => {
    const macros = parseMacros('Hello {$name}, {set $x = 1}');
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('set');
  });
});

describe('pairMacros', () => {
  it('pairs matching open/close', () => {
    const macros = parseMacros('{if $x}text{/if}');
    pairMacros(macros, (name) => name === 'if');
    expect(macros[0].pair).toBe(macros[1].id);
    expect(macros[1].pair).toBe(macros[0].id);
  });

  it('pairs nested containers', () => {
    const macros = parseMacros('{if $x}{if $y}inner{/if}{/if}');
    pairMacros(macros, (name) => name === 'if');
    // Inner pair
    expect(macros[1].pair).toBe(macros[2].id);
    // Outer pair
    expect(macros[0].pair).toBe(macros[3].id);
  });

  it('leaves non-block macros unpaired', () => {
    const macros = parseMacros('{set $x = 1}');
    pairMacros(macros, () => false);
    expect(macros[0].pair).toBe(-1);
  });

  it('leaves unmatched macros unpaired', () => {
    const macros = parseMacros('{if $x}no closing');
    pairMacros(macros, (name) => name === 'if');
    expect(macros[0].pair).toBe(-1);
  });
});
