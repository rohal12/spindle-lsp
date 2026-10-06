/**
 * Global setup of the retained matrix (vitest.review.config.ts):
 *  - builds the executable once for every entrypoint cell, instead of per cell
 *    or per worker (`inject('reviewExecutable')`);
 *  - after all shard files ran, merges their records in sequence order and
 *    checks them against docs/reviews/2026-10-06-cross-consumer-results.json
 *    (the committed file must list the cells and states of the run), or
 *    rewrites that file with REVIEW_WRITE_RESULTS=1.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';
import { INSTALLED_SPINDLE_VERSION } from '../helpers/spindle-version.js';
import { buildDist } from '../integration/support/dist-build.js';
import { SHARDS } from './support/shard-names.js';
import type { CellRecord } from './support/harness.js';

const RESULTS = join(process.cwd(), 'docs/reviews/2026-10-06-cross-consumer-results.json');

interface ShardFile { shard: string; total: number; records: Array<CellRecord & { seq: number }> }

export default function setup({ provide }: GlobalSetupContext) {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-review-'));
  const dist = buildDist();
  provide('reviewExecutable', dist.executable);
  provide('reviewResultsDir', dir);

  return function teardown() {
    try {
      dist.dispose();
      const shards = readdirSync(dir).map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as ShardFile);
      if (shards.length === 0) return; // nothing ran (every test file was filtered out)
      // REVIEW_PARTIAL=1: a deliberate partial run (one shard file, a name filter); nothing to compare
      if (process.env.REVIEW_PARTIAL) return;
      const missing = SHARDS.filter(name => !shards.some(s => s.shard === name));
      const records = shards.flatMap(s => s.records).sort((a, b) => a.seq - b.seq);
      const total = shards[0].total;
      const problems: string[] = [];
      if (shards.some(s => s.total !== total)) problems.push('shards disagree on the number of cells');
      if (missing.length > 0) problems.push(`no records from shard(s) ${missing.join(', ')} (a shard file did not run to the end, or the run was filtered)`);
      const seqs = new Set(records.map(r => r.seq));
      if (seqs.size !== records.length || records.length !== total) problems.push(`${records.length} of ${total} cells were recorded`);
      const cells = records.map(({ seq: _seq, ...rest }) => rest as CellRecord);

      if (process.env.REVIEW_WRITE_RESULTS) {
        if (problems.length > 0) throw new Error(`not rewriting the results file: ${problems.join('; ')}`);
        const counts: Record<string, number> = { pass: 0, fail: 0, 'not-run': 0, 'not-applicable': 0 };
        for (const r of cells) counts[r.status]++;
        writeFileSync(RESULTS, JSON.stringify({
          generated: '2026-10-06',
          spindleVersion: INSTALLED_SPINDLE_VERSION,
          summary: { total: cells.length, ...counts },
          cells,
        }, null, 1) + '\n');
        return;
      }

      const file = JSON.parse(readFileSync(RESULTS, 'utf-8')) as { cells: CellRecord[] };
      const mine = new Map(cells.map(r => [r.id, r.status]));
      const kept = new Map(file.cells.map(c => [c.id, c.status]));
      for (const id of mine.keys()) if (!kept.has(id)) problems.push(`cell ${id} is not in the results file`);
      for (const id of kept.keys()) if (!mine.has(id)) problems.push(`results file lists ${id}, which did not run`);
      for (const [id, status] of mine) if (kept.has(id) && kept.get(id) !== status) problems.push(`${id}: results file says ${kept.get(id)}, the run says ${status}`);
      for (const r of cells) if (r.status === 'not-run') problems.push(`${r.id} did not run`);
      if (problems.length > 0) {
        throw new Error(`docs/reviews/2026-10-06-cross-consumer-results.json does not match this run (REVIEW_WRITE_RESULTS=1 rewrites it):\n  ${problems.slice(0, 20).join('\n  ')}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
