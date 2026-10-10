import {
  builtinMacros,
  parseStoryVariables,
  validateVariableReferences,
  type FieldSchema,
  type VariableSchema,
} from '@rohal12/spindle/tooling';

export { parseStoryVariables };
export type { FieldSchema, VariableSchema };

/** The names of an object variable's declared fields (`fields` is a Map in Spindle 0.59). */
export function fieldNames(schema: FieldSchema | undefined): string[] {
  return schema?.fields ? [...schema.fields.keys()] : [];
}

/** A passage as `validatePassages` takes it. */
interface OraclePassage {
  name: string;
  content: string;
  tags?: string[];
}

/**
 * Spindle's startup validation of the variable references of a story against
 * its `StoryVariables` (the "Undeclared variable: $x" and "Cannot access
 * field ..." errors, as the runtime words them after `Passage "name": `),
 * through the public tooling API (`validateVariableReferences`, which is the
 * check the runtime runs).
 */
export function validatePassages(passages: Map<string, OraclePassage>, schema: Map<string, VariableSchema>): string[] {
  return validateVariableReferences(passages.values(), { variables: schema }, builtinMacros)
    .map(diagnostic => `Passage "${diagnostic.passage}": ${diagnostic.message}`);
}
