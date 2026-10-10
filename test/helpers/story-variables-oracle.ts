import {
  builtinMacros,
  parseStoryVariables,
  validateVariableReferences,
  type FieldSchema,
  type MarkupPassage,
  type VariableSchema,
} from '@rohal12/spindle/tooling';

export { parseStoryVariables };
export type { FieldSchema, VariableSchema };

/** The names of an object variable's declared fields (`fields` is a Map in Spindle 0.59). */
export function fieldNames(schema: FieldSchema | undefined): string[] {
  return schema?.fields ? [...schema.fields.keys()] : [];
}

/**
 * The runtime's startup validation of variable references against the
 * declarations (`validateVariableReferences`, Spindle >= 0.59.25): the
 * "Undeclared variable: $x" and "Cannot access field ..." errors, each as the
 * story start shows it (`Passage "name": message`). The passages are checked
 * with the built-in macros.
 */
export function validatePassages(
  passages: Map<string, MarkupPassage>,
  schema: ReadonlyMap<string, FieldSchema | undefined>,
  transients?: ReadonlyMap<string, FieldSchema | undefined>,
): string[] {
  return validateVariableReferences(passages.values(), { variables: schema, transients }, builtinMacros)
    .map(d => `Passage "${d.passage}": ${d.message}`);
}
