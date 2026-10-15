import { describe, it, expect } from 'vitest';
import type { Observation } from '@rohal12/spindle';
import { formatObservation } from '../../src/mcp/play/format-observation.js';

const base: Observation = {
  passage: 'Crossroads',
  text: 'Roads split.',
  context: null,
  dialogs: [],
  actions: [],
  errors: [],
  turn: 4,
};

describe('formatObservation', () => {
  it('renders the minimal observation', () =>
    expect(formatObservation(base)).toBe(
      'Passage: Crossroads   (turn 4)\n\nRoads split.\n\nContext:\n(none)\n\nActions: none (ending or dead end)',
    ));

  it('lists actions with type, label, target, variable, value, options and disabled', () => {
    const text = formatObservation({
      ...base,
      actions: [
        { id: 'link-0', type: 'link', label: 'Go north', target: 'North Road' },
        {
          id: 'listbox-0',
          type: 'listbox',
          label: 'sword',
          variable: 'weapon',
          value: 'sword',
          options: ['sword', 'axe', 'bow'],
        },
        { id: 'button-1', type: 'button', label: 'Rest', disabled: true },
      ],
    });
    expect(text).toContain(
      'Actions:\n1. link-0     link     "Go north" -> North Road\n2. listbox-0  listbox  $weapon = "sword"  options: sword, axe, bow\n3. button-1   button   "Rest" (disabled)',
    );
  });

  it('renders an unset input value, an input without options and a disabled input', () => {
    const text = formatObservation({
      ...base,
      actions: [
        { id: 'textbox-0', type: 'textbox', label: '', variable: 'name', value: undefined },
        { id: 'checkbox-0', type: 'checkbox', label: 'Brave', variable: 'brave', value: false },
        {
          id: 'listbox-0',
          type: 'listbox',
          label: 'axe',
          variable: 'weapon',
          value: 'axe',
          options: ['sword', 'axe'],
          disabled: true,
        },
      ],
    });
    expect(text).toContain(
      'Actions:\n1. textbox-0   textbox   $name = (unset)\n2. checkbox-0  checkbox  $brave = false\n3. listbox-0   listbox   $weapon = "axe"  options: sword, axe (disabled)',
    );
  });

  it('renders input values that JSON cannot as JSON-safe values', () => {
    const text = formatObservation({
      ...base,
      actions: [
        { id: 'a', type: 'textbox', label: '', variable: 'big', value: 10n },
        { id: 'b', type: 'textbox', label: '', variable: 'bag', value: new Map([['k', 1]]) },
      ],
    });
    expect(text).toContain('1. a  textbox  $big = "10"\n2. b  textbox  $bag = {"k":1}');
  });

  it('escapes quotes and newlines in labels', () => {
    const text = formatObservation({
      ...base,
      actions: [{ id: 'link-0', type: 'link', label: 'Say "hi"\nand go', target: 'Hall' }],
    });
    expect(text).toContain('1. link-0  link  "Say \\"hi\\"\\nand go" -> Hall');
  });

  it('pads the action number to the widest one', () => {
    const actions = Array.from({ length: 10 }, (_, i) => ({
      id: `link-${i}`,
      type: 'link',
      label: `L${i}`,
    }));
    const lines = formatObservation({ ...base, actions }).split('\n');
    expect(lines).toContain(' 1. link-0  link  "L0"');
    expect(lines).toContain('10. link-9  link  "L9"');
  });

  it('includes context, dialogs and errors sections only when present', () => {
    const plain = formatObservation(base);
    expect(plain).not.toContain('Dialogs:');
    expect(plain).not.toContain('Errors:');

    const full = formatObservation({
      ...base,
      context: 'HP 3',
      dialogs: [{ passage: 'Map', text: 'A map' }],
      errors: ['x'],
    });
    expect(full).toContain('Context:\nHP 3');
    expect(full).not.toContain('(none)');
    expect(full).toContain('Dialogs:\n- Map: A map');
    expect(full).toContain('Errors:\n- x');
    expect(full.indexOf('Dialogs:')).toBeGreaterThan(full.indexOf('Context:'));
    expect(full.indexOf('Actions:')).toBeGreaterThan(full.indexOf('Dialogs:'));
    expect(full.indexOf('Errors:')).toBeGreaterThan(full.indexOf('Actions:'));
  });
});
