import type { FieldSchema } from '@rohal12/spindle/tooling';
import type { VariableValueType } from '../types.js';

/**
 * Boxed sample values whose members a primitive of each type can access, as
 * in Spindle's startup validation (`validateRef` in story-variables.ts): `part
 * in sample` and the `typeof` of the member decide how the walk continues.
 */
const PRIMITIVE_SAMPLES: Partial<Record<FieldSchema['type'], object>> = {
  string: Object(''),
  number: Object(0),
  boolean: Object(false),
};

/**
 * Walk `fields` (a path below a variable) through its schema as Spindle's
 * startup validation does, and return the first field it rejects: one
 * accessed on a number, string or boolean. Spindle allows any field of an
 * array or of a null default (it may hold anything later) and any field an
 * object's default does not have, so the walk stops there, and it stops
 * wherever the schema does not know a type. A member of the primitive's
 * wrapper (`length`, `toFixed`, ...) is allowed: the walk continues with the
 * member's type when that is a number, string or boolean, and stops for any
 * other member.
 *
 * (Spindle does not export this rule; see
 * https://github.com/rohal12/spindle/issues/464.)
 */
export function findPrimitiveFieldAccess(
  schema: FieldSchema,
  fields: string[],
): { index: number; type: VariableValueType } | undefined {
  let current = schema;
  for (let i = 0; i < fields.length; i++) {
    if (current.type === 'array' || current.type === 'null') return undefined;
    const sample = PRIMITIVE_SAMPLES[current.type];
    if (sample && fields[i] in sample) {
      const memberType = typeof sample[fields[i] as keyof typeof sample];
      if (memberType !== 'number' && memberType !== 'string' && memberType !== 'boolean') return undefined;
      current = { type: memberType };
      continue;
    }
    if (current.type !== 'object') return { index: i, type: current.type };
    const next = current.fields?.get(fields[i]);
    if (!next) return undefined;
    current = next;
  }
  return undefined;
}
