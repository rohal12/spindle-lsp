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
