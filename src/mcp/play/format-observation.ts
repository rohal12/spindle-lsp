import type { Observation, ObservedAction } from '@rohal12/spindle/play';

import { toJsonSafe } from './json-safe.js';

const COLUMN_GAP = 2;

function describeAction(action: ObservedAction): string {
  let text: string;
  if (action.variable !== undefined) {
    const value = action.value === undefined ? '(unset)' : JSON.stringify(toJsonSafe(action.value));
    text = `$${action.variable} = ${value}`;
    if (action.options?.length) text += `  options: ${action.options.join(', ')}`;
  } else {
    text = JSON.stringify(action.label);
    if (action.target !== undefined) text += ` -> ${action.target}`;
  }
  return action.disabled ? `${text} (disabled)` : text;
}

function formatActions(actions: ObservedAction[]): string {
  if (actions.length === 0) return 'Actions: none (ending or dead end)';
  const idWidth = Math.max(...actions.map((a) => a.id.length)) + COLUMN_GAP;
  const typeWidth = Math.max(...actions.map((a) => a.type.length)) + COLUMN_GAP;
  const numberWidth = `${actions.length}.`.length;
  const rows = actions.map((a, i) => {
    const number = `${i + 1}.`.padStart(numberWidth);
    return `${number} ${a.id.padEnd(idWidth)}${a.type.padEnd(typeWidth)}${describeAction(a)}`;
  });
  return `Actions:\n${rows.join('\n')}`;
}

/** Renders what a reader sees and can do as text for a coding agent. */
export function formatObservation(o: Observation): string {
  const sections = [
    `Passage: ${o.passage}   (turn ${o.turn})`,
    o.text,
    `Context:\n${o.context ?? '(none)'}`,
  ];
  if (o.dialogs.length > 0) {
    sections.push(`Dialogs:\n${o.dialogs.map((d) => `- ${d.passage}: ${d.text}`).join('\n')}`);
  }
  sections.push(formatActions(o.actions));
  if (o.errors.length > 0) {
    sections.push(`Errors:\n${o.errors.map((e) => `- ${e}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
