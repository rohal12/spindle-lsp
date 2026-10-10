import { parseStoryVariables, type FieldSchema, type VariableSchema } from '@rohal12/spindle/tooling';

export { parseStoryVariables };
export type { FieldSchema, VariableSchema };

/** The names of an object variable's declared fields (`fields` is a Map in Spindle 0.59). */
export function fieldNames(schema: FieldSchema | undefined): string[] {
  return schema?.fields ? [...schema.fields.keys()] : [];
}

/**
 * NEEDS UPSTREAM API. Spindle's startup validation of variable references
 * against the declarations (`validatePassages` in story-variables.ts: the
 * "Undeclared variable: $x" and "Cannot access field ..." errors) is not
 * exported by `@rohal12/spindle/tooling`, and the module cannot be imported
 * under vitest (it pulls in the Peggy grammar). `validateMarkup` /
 * `validateStoryMarkup` check markup, code syntax and passage names, not
 * variable references. Rebuilding the rule from `passagePieces` + `lexJs`
 * here would make the differential tests compare the LSP with a copy of
 * itself, so this fails loudly instead.
 *
 * Missing capability: `validateVariableReferences(passages, schema, macros)`
 * (or a `schema` option of `validateStoryMarkup`) returning the runtime's
 * undeclared-variable and field-access errors.
 */
export function validatePassages(_passages: Map<string, unknown>, _schema: Map<string, unknown>, ..._rest: unknown[]): string[] {
  throw new Error('needs upstream API: Spindle exports no startup variable validation (validatePassages) from @rohal12/spindle/tooling');
}
