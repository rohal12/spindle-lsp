/** The shard files of the retained matrix; kept free of test code so global-setup can read it. */
/** Shard names. Scenes are dealt round-robin to the matrix shards; the state differentials to the state shards. */
export const MATRIX_SHARDS = 10;
export const STATE_SHARDS = 4;
export const SHARDS = [
  ...Array.from({ length: MATRIX_SHARDS }, (_, i) => `matrix-${i + 1}`),
  ...Array.from({ length: STATE_SHARDS }, (_, i) => `state-${i + 1}`),
  'completion', 'entry-cli', 'entry-lsp', 'named',
];

