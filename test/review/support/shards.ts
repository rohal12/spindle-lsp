/**
 * Registers the retained cross-consumer matrix in one shard file.
 *
 * The matrix is one ordered list of cells (the scenes x properties, then the
 * interactive and entrypoint cells, then the named cells without a check).
 * Every shard file walks the whole list, so a cell has the same sequence
 * number everywhere, but runs only the cells that `shardOf` assigns to it.
 * That lets vitest run the shard files in parallel workers. Each shard writes
 * its records to the results directory; `global-setup.ts` merges them in
 * sequence order and compares them with
 * docs/reviews/2026-10-06-cross-consumer-results.json (or rewrites it with
 * REVIEW_WRITE_RESULTS=1).
 */
import { afterAll, afterEach, it, inject } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NotApplicable, disposeAll, disposeShared, notApplicable,
  type CellRecord, type Dims,
} from './harness.js';
import {
  propBounds, propFormat, propFormatDoLiterals, propHover, propMacroHeadOracle, propNavigationAgree, propPassageOracle,
  propRename, propStateIncremental, propStateOrder, propTokens,
} from './properties.js';
import { registerInteractiveCells } from './interactive.js';
import { BASE, NOT_APPLICABLE, STATE_SUBSET, TARGET_FILE, files, scenes } from './corpus.js';

import { MATRIX_SHARDS, SHARDS, STATE_SHARDS } from './shard-names.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The executable built once by global-setup.ts. */
    reviewExecutable: string;
    /** Where each shard leaves its records for the merge. */
    reviewResultsDir: string;
  }
}

interface SeqRecord extends CellRecord { seq: number }

/** The shard of a cell that is not a matrix cell, from its id. */
function shardOfId(id: string): string {
  if (id.startsWith('I/entry-cli')) return 'entry-cli';
  if (id.startsWith('I/entry-lsp')) return 'entry-lsp';
  if (id.startsWith('N/')) return 'named';
  return 'completion';
}

export function registerShard(shard: string): void {
  if (!SHARDS.includes(shard)) throw new Error(`unknown shard ${shard}`);
  const records: SeqRecord[] = [];
  let seq = 0;

  /** Declares one cell: an `it` whose outcome is recorded. Only the cells of this shard get an `it`. */
  function cell(id: string, dims: Dims, fn: () => void | Promise<void>, owner: string = shardOfId(id)) {
    const n = seq++;
    if (owner !== shard) return;
    it(id, async () => {
      const rec: SeqRecord = { id, ...dims, status: 'pass', seq: n };
      records.push(rec);
      try {
        await fn();
      } catch (error) {
        if (error instanceof NotApplicable) { rec.status = 'not-applicable'; rec.note = error.message; return; }
        rec.status = 'fail';
        rec.note = String((error as Error).message).split('\n')[0].slice(0, 300);
        throw error;
      } finally {
        // Most cells are synchronous CPU work. Yield to the event loop between cells so the worker keeps
        // answering vitest's RPC (task updates, heartbeats) however long the shard runs.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    });
  }

  afterEach(() => disposeAll());

  // the matrix: scenes x properties
  {
    let state = 0;
    scenes.forEach((s, index) => {
      const owner = `matrix-${(index % MATRIX_SHARDS) + 1}`;
      const d = (consumer: string): Dims => ({ ...s.dims, consumer });
      cell(`${s.id} [bounds]`, d('all consumers: ranges within document and UTF-16 valid'), () => propBounds(s.files), owner);
      cell(`${s.id} [navigation]`, d('references x definition x prepareRename'), () => propNavigationAgree(s.files), owner);
      cell(`${s.id} [passage-oracle]`, d('diagnostics x references x document links x code lens vs runtime'), () => propPassageOracle(s.files), owner);
      cell(`${s.id} [macro-oracle]`, d('diagnostics x semantic tokens x widget references vs runtime'), () => propMacroHeadOracle(s.files), owner);
      cell(`${s.id} [rename]`, d('prepareRename/rename applied, rebuilt, re-diagnosed, reparsed'), () => propRename(s.files), owner);
      cell(`${s.id} [format]`, d('formatting: idempotent, same diagnostics, same runtime payload'), () => propFormat(s.files), owner);
      if (s.id.startsWith('F/')) cell(`${s.id} [do-literal]`, d('formatting: do-body JavaScript values identical, idempotent, unrelated text preserved'), () => propFormatDoLiterals(s.files), owner);
      cell(`${s.id} [hover]`, d('hover: variables and macros agree with semantic tokens and runtime tokens'), () => propHover(s.files), owner);
      cell(`${s.id} [tokens]`, d('semantic tokens validity and agreement'), () => propTokens(s.files), owner);
      if (STATE_SUBSET.has(s.id)) {
        const stateOwner = `state-${(state++ % STATE_SHARDS) + 1}`;
        cell(`${s.id} [state-order]`, { ...s.dims, state: 'initialization order permuted', consumer: 'all read-only consumers' }, () => propStateOrder(s.files), stateOwner);
        cell(`${s.id} [state-incremental]`, { ...s.dims, state: 'open one by one / unsaved edit+revert / close+reopen', consumer: 'all read-only consumers' }, () => propStateIncremental(s.files), stateOwner);
      }
    });
  }

  registerInteractiveCells(cell, { files, BASE, TARGET_FILE });

  // named cells that are decided but have nothing to execute
  for (const [id, dims, reason] of NOT_APPLICABLE) cell(id, dims, () => notApplicable(reason));

  afterAll(() => {
    disposeShared();
    writeFileSync(join(inject('reviewResultsDir'), `${shard}.json`), JSON.stringify({ shard, total: seq, records }));
  });
}
