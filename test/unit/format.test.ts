import { describe, it, expect } from 'vitest';
import { formatDocument, formatRange } from '../../src/plugins/format.js';

describe('formatDocument', () => {
  // -- Existing behavior -------------------------------------------------

  it('indents content inside {if} by 2 spaces', async () => {
    const input = ':: Start\n{if $x}\n{set $y = 1}\n{/if}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {set $y = 1}');
  });

  it('handles nested indentation (2 and 4 spaces)', async () => {
    const input = ':: Start\n{if $x}\n{for @item range $list}\n{set $y = 1}\n{/for}\n{/if}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {for @item range $list}');
    expect(lines[3]).toBe('    {set $y = 1}');
    expect(lines[4]).toBe('  {/for}');
    expect(lines[5]).toBe('{/if}');
  });

  it('removes trailing whitespace from lines', async () => {
    const input = ':: Start   \nHello world   \n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Start');
    expect(lines[1]).toBe('Hello world');
  });

  it('ensures file ends with a single newline', async () => {
    const input = ':: Start\nHello world';
    const result = await formatDocument(input);
    expect(result.endsWith('\n')).toBe(true);
    expect(result.endsWith('\n\n')).toBe(false);
  });

  it('collapses multiple trailing newlines to one', async () => {
    const input = ':: Start\nHello world\n\n\n\n';
    const result = await formatDocument(input);
    expect(result).toBe(':: Start\nHello world\n');
  });

  it('normalizes passage headers with extra whitespace', async () => {
    const input = '::  Name  [tag]\nContent\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Name [tag]');
  });

  it('normalizes passage header with metadata braces', async () => {
    const input = '::  MyPassage  {"position": "100,200"}\nContent\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: MyPassage {"position": "100,200"}');
  });

  it('returns already-formatted document unchanged', async () => {
    const input = ':: Start\n{if $x}\n  {set $y = 1}\n{/if}\n';
    const result = await formatDocument(input);
    expect(result).toBe(input);
  });

  it('resets indent level at passage boundaries', async () => {
    const input = ':: Passage1\n{if $x}\nContent\n\n:: Passage2\nMore content\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[5]).toBe('More content');
  });

  it('handles empty input', async () => {
    const result = await formatDocument('');
    expect(result).toBe('\n');
  });

  it('handles widget blocks', async () => {
    const input = ':: Widgets [widget]\n{widget "greet" @name}\nHello {@name}\n{/widget}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  Hello {@name}');
    expect(lines[3]).toBe('{/widget}');
  });

  // -- New container macros ----------------------------------------------

  it('indents content inside {button}', async () => {
    const input = ':: Start\n{button "Click"}\n{set $x = 1}\n{/button}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {set $x = 1}');
  });

  it('indents content inside {do}', async () => {
    const input = ':: Start\n{do}\n{set $x = 1}\n{/do}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {set $x = 1}');
  });

  it('indents content inside {link}', async () => {
    const input = ':: Start\n{link "Go" "Next"}\n{set $x = 1}\n{/link}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {set $x = 1}');
  });

  it('indents content inside {timed}', async () => {
    const input = ':: Start\n{timed 2s}\nFirst\n{/timed}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  First');
  });

  it('indents content inside {repeat}', async () => {
    const input = ':: Start\n{repeat 1s}\nContent\n{/repeat}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {type}', async () => {
    const input = ':: Start\n{type 30}\nContent\n{/type}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {dialog}', async () => {
    const input = ':: Start\n{dialog "Title"}\nContent\n{/dialog}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {nobr}', async () => {
    const input = ':: Start\n{nobr}\nContent\n{/nobr}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {span}', async () => {
    const input = ':: Start\n{span}\nContent\n{/span}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  it('indents content inside {listbox}', async () => {
    const input = ':: Start\n{listbox "$x"}\n{option "a"}\n{/listbox}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {option "a"}');
  });

  it('indents content inside {cycle}', async () => {
    const input = ':: Start\n{cycle "$x"}\n{option "a"}\n{/cycle}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  {option "a"}');
  });

  it('indents content inside {unless}', async () => {
    const input = ':: Start\n{unless $x}\nContent\n{/unless}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Content');
  });

  // -- Custom macros via auto-detection ----------------------------------

  it('auto-detects custom container macros from closing tags', async () => {
    const input = ':: Start\n{Section "Vitals"}\n{StatBar "HP" $hp 10}\n{/Section}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {StatBar "HP" $hp 10}');
    expect(lines[3]).toBe('{/Section}');
  });

  // -- Registry-backed isBlock callback ----------------------------------

  it('uses provided isBlock callback', async () => {
    const input = ':: Start\n{CustomBlock}\nContent\n{/CustomBlock}\n';
    const result = await formatDocument(input, {
      isBlock: (name) => name.toLowerCase() === 'customblock',
    });
    expect(result.split('\n')[2]).toBe('  Content');
  });

  // -- Dedenting sub-macros ----------------------------------------------

  it('dedents {else} to parent level', async () => {
    const input = ':: Start\n{if $x}\ncontent\n{else}\nfallback\n{/if}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[1]).toBe('{if $x}');
    expect(lines[2]).toBe('  content');
    expect(lines[3]).toBe('{else}');
    expect(lines[4]).toBe('  fallback');
    expect(lines[5]).toBe('{/if}');
  });

  it('dedents {elseif} to parent level', async () => {
    const input = ':: Start\n{if $x}\na\n{elseif $y}\nb\n{else}\nc\n{/if}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[2]).toBe('  a');
    expect(lines[3]).toBe('{elseif $y}');
    expect(lines[4]).toBe('  b');
    expect(lines[5]).toBe('{else}');
    expect(lines[6]).toBe('  c');
  });

  it('dedents {next} inside {timed} to parent level', async () => {
    const input = ':: Start\n{timed 2s}\nFirst\n{next 2s}\nSecond\n{next}\nThird\n{/timed}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[1]).toBe('{timed 2s}');
    expect(lines[2]).toBe('  First');
    expect(lines[3]).toBe('{next 2s}');
    expect(lines[4]).toBe('  Second');
    expect(lines[5]).toBe('{next}');
    expect(lines[6]).toBe('  Third');
    expect(lines[7]).toBe('{/timed}');
  });

  it('dedents {case} and {default} to parent level inside {switch}', async () => {
    const input = ':: Start\n{switch $x}\n{case "a"}\nbranch a\n{default}\nfallback\n{/switch}\n';
    const result = await formatDocument(input);
    const lines = result.split('\n');
    expect(lines[1]).toBe('{switch $x}');
    expect(lines[2]).toBe('{case "a"}');
    expect(lines[3]).toBe('  branch a');
    expect(lines[4]).toBe('{default}');
    expect(lines[5]).toBe('  fallback');
    expect(lines[6]).toBe('{/switch}');
  });

  // -- Macros with CSS prefix --------------------------------------------

  it('indents content inside macros with CSS prefix', async () => {
    const input = ':: Start\n{.red#alert if $danger}\nWarning!\n{/if}\n';
    const result = await formatDocument(input);
    expect(result.split('\n')[2]).toBe('  Warning!');
  });

  // -- Script passage formatting ------------------------------------------

  it('formats JavaScript in [script]-tagged passages', async () => {
    const input = ':: Init [script]\nconst   x=1;const y = 2\n';
    const result = await formatDocument(input);
    expect(result).toContain('const x = 1;');
  });

  it('leaves malformed JS in [script] passages as-is', async () => {
    const input = ':: Init [script]\nconst x = {{{\n';
    const result = await formatDocument(input);
    expect(result).toContain('const x = {{{');
  });

  // -- Stylesheet passage formatting -------------------------------------

  it('formats CSS in [stylesheet]-tagged passages', async () => {
    const input = ':: Styles [stylesheet]\n.foo{color:red;display:block}\n';
    const result = await formatDocument(input);
    expect(result).toContain('color: red;');
  });

  // -- Inline <script> formatting ----------------------------------------

  it('formats JavaScript inside <script> tags', async () => {
    const input = ':: Start\n<script>\nconst   x=1\n</script>\n';
    const result = await formatDocument(input);
    expect(result).toContain('const x = 1;');
  });

  // -- HTML block formatting ---------------------------------------------

  it('formats multi-line HTML and preserves Spindle tokens', async () => {
    const input = ':: Start\n<div>\n<span>{$name}</span>\n</div>\n';
    const result = await formatDocument(input);
    expect(result).toContain('{$name}');
  });

  it('preserves Spindle links inside HTML', async () => {
    const input = ':: Start\n<div>\n<span>[[Home]]</span>\n</div>\n';
    const result = await formatDocument(input);
    expect(result).toContain('[[Home]]');
  });

  // -- HTML blocks with Spindle macros (regression) ----------------------

  it('preserves {button} inside HTML blocks', async () => {
    const input = [
      ':: Actions [nobr]',
      '<div class="menu">',
      '{for @action of $actions}',
      '<button class="btn" data-action="do" data-id="{@action.id}">{@action.name}</button>',
      '{/for}',
      '</div>',
      '',
    ].join('\n');
    const result = await formatDocument(input);
    // The <button> tag must remain intact — not split across lines or corrupted
    expect(result).toContain('<button');
    expect(result).toContain('</button>');
    // The macro tokens inside attributes must survive
    expect(result).toContain('{@action.id}');
    expect(result).toContain('{@action.name}');
  });

  it('preserves {button} with macro arguments inside {widget}', async () => {
    const input = [
      ':: Widgets [widget]',
      '{widget "OpenPad" @view @label}',
      '<div class="choices-section">',
      '{button "{@label}"}{set $view = @view}{do} Story.goto("blank"); {/do}{/button}',
      '</div>',
      '{/widget}',
      '',
    ].join('\n');
    const result = await formatDocument(input);
    // The single-line {button} must not be split across multiple lines
    const buttonLine = result.split('\n').find(l => l.includes('{button'));
    expect(buttonLine).toBeDefined();
    expect(buttonLine).toContain('{/button}');
  });

  it('is idempotent with <button> inside {for} in HTML blocks', async () => {
    const input = [
      ':: Panel [nobr]',
      '<div class="panel">',
      '{for @item of $items}',
      '<button class="item-btn" data-id="{@item.id}">{@item.name}</button>',
      '{/for}',
      '</div>',
      '',
    ].join('\n');
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });

  it('is idempotent with complex ALMA-style panel', async () => {
    const input = [
      ':: ALMAPanel [nobr]',
      '<div class="alma-panel">',
      '<div class="header">Day {$game.day}</div>',
      '{if $npc_plans.length > 0}',
      '<div class="crew">',
      '{for @plan of $npc_plans}',
      '<div class="row"><span>{@plan.name}</span></div>',
      '{/for}',
      '</div>',
      '{/if}',
      '<div class="actions">',
      '{for @action of $actions}',
      '<button class="action-btn {if @action.cost > $ap.current}disabled{/if}" data-action="game-action" data-action-id="{@action.id}"><span>{@action.name}</span><span>{@action.cost} AP</span></button>',
      '{/for}',
      '</div>',
      '</div>',
      '',
    ].join('\n');
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });

  it('is idempotent with multi-attribute div and {include} macros', async () => {
    const input = [
      ':: StoryInterface',
      '<div id="interface">',
      '<div id="top-bar">',
      '{include "TopBar"}',
      '</div>',
      '<div id="main" class="main-content-area" data-section="primary" data-scrollable="true">',
      '{include "PCStatus"}',
      '</div>',
      '</div>',
      '',
    ].join('\n');
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });

  // -- SVG preservation (issue #5) ----------------------------------------

  it('does not reformat SVG tags to multi-line', async () => {
    const input = [
      ':: Test',
      '<div class="wrapper"><svg class="my-svg" width="100" height="100" viewBox="0 0 100 100">',
      '<circle cx="50" cy="50" r="40"></circle>',
      '</svg></div>',
      '',
    ].join('\n');
    const result = await formatDocument(input);
    // SVG attributes must stay on one line — not broken across lines by Prettier
    expect(result).toContain('viewBox="0 0 100 100"');
    expect(result).not.toContain('<svg\n');
  });

  it('is idempotent with SVG blocks', async () => {
    const input = [
      ':: Test',
      '<svg class="my-svg" width="100" height="100" viewBox="0 0 100 100">',
      '<circle cx="50" cy="50" r="40"></circle>',
      '</svg>',
      '',
    ].join('\n');
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });

  it('preserves SVG inside a wrapper div without reformatting', async () => {
    const input = [
      ':: Icons',
      '<div class="icon-container">',
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">',
      '<path d="M12 2L2 7l10 5 10-5-10-5z"></path>',
      '</svg>',
      '</div>',
      '',
    ].join('\n');
    const result = await formatDocument(input);
    // The SVG opening tag must not be split across lines
    const svgLine = result.split('\n').find(l => l.includes('<svg'));
    expect(svgLine).toContain('viewBox="0 0 24 24"');
  });

  // -- Idempotency -------------------------------------------------------

  it('is idempotent — double formatting produces same result', async () => {
    const input = ':: Start\n{if $x}\n{Section "V"}\ncontent\n{/Section}\n{/if}\n';
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });

  it('is idempotent with HTML blocks', async () => {
    const input = ':: Start\n<div>\n<span>{$name}</span>\n</div>\n';
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });

  it('is idempotent with script passages', async () => {
    const input = ':: Init [script]\nconst   x=1;const y = 2\n';
    const first = await formatDocument(input);
    const second = await formatDocument(first);
    expect(second).toBe(first);
  });
});

describe('formatRange', () => {
  it('formats the full document (range is advisory)', async () => {
    const input = ':: Start\n{if $x}\n{set $y = 1}\n{/if}\n:: Next\nContent\n';
    const result = await formatRange(input, {
      start: { line: 1, character: 0 },
      end: { line: 3, character: 4 },
    });
    const lines = result.split('\n');
    expect(lines[2]).toBe('  {set $y = 1}');
    expect(lines[5]).toBe('Content');
  });

  it('normalizes passage headers even outside range', async () => {
    const input = '::  Start  [tag]\nContent\n';
    const result = await formatRange(input, {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 0 },
    });
    const lines = result.split('\n');
    expect(lines[0]).toBe(':: Start [tag]');
  });
});
