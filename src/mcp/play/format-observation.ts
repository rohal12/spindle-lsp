import type { Observation, ObservedAction } from '@rohal12/spindle/play';

const COLUMN_GAP = 2;

function describeAction(action: ObservedAction): string {
  let text: string;
  if (action.variable !== undefined) {
    text = `$${action.variable} = ${JSON.stringify(action.value)}`;
    if (action.options?.length) text += `  options: ${action.options.join(', ')}`;
  } else {
    text = `"${action.label}"`;
    if (action.target !== undefined) text += ` -> ${action.target}`;
  }
  return action.disabled ? `${text} (disabled)` : text;
}

function formatActions(actions: ObservedAction[]): string {
  if (actions.length === 0) return 'Actions: none (ending or dead end)';
  const idWidth = Math.max(...actions.map((a) => a.id.length)) + COLUMN_GAP;
  const typeWidth = Math.max(...actions.map((a) => a.type.length)) + COLUMN_GAP;
  const rows = actions.map(
    (a, i) => `${i + 1}. ${a.id.padEnd(idWidth)}${a.type.padEnd(typeWidth)}${describeAction(a)}`,
  );
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
