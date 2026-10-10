/**
 * Code duplication check: measures the production code (src/) with one tool
 * and fails when duplication exceeds the budget or, given a base ref, grows
 * relative to it.
 *
 *   node scripts/duplication.ts jscpd              # measure, check budget
 *   node scripts/duplication.ts fallow --base main # also compare with main
 *
 * The tools see different things, so CI runs all three:
 * - jscpd: exact copies (identical token streams).
 * - PMD CPD: exact copies, grouping repeats of the same code into one clone
 *   with every occurrence. Needs Java and PMD: set PMD_BIN to PMD's `pmd`
 *   script, or put it on PATH.
 * - fallow (semantic mode): copies with renamed identifiers and changed
 *   literals; it misses some exact copies the other two find.
 *
 * jscpd and fallow read their settings from .jscpd.json and .fallowrc.json;
 * CPD takes jscpd's paths and minimum token count. A base ref is measured with
 * the same settings, so a settings change never shows up as a change in
 * duplication. The budget is in duplication-budget.json. In GitHub Actions the
 * result is written to the job summary.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = ['jscpd', 'cpd', 'fallow'] as const;
type Tool = (typeof TOOLS)[number];

interface Clone {
  /** Identifies the clone across trees: its files and instance sizes. */
  key: string;
  lines: number;
  locations: string[];
}

interface Measurement {
  percentage: number;
  duplicatedLines: number;
  totalLines: number;
  clones: Clone[];
}

interface Budget {
  /** Highest duplication percentage allowed, per tool. */
  maxPercentage: Record<Tool, number>;
}

interface Location {
  file: string;
  start: number;
  end: number;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'node_modules', '.bin');

const jscpdConfig = JSON.parse(
  readFileSync(join(ROOT, '.jscpd.json'), 'utf8'),
) as { path: string[]; minTokens: number };

/** A clone made of `instances`, with paths relative to `tree`. */
function clone(tree: string, instances: Location[]): Clone {
  const at = (l: Location) => ({
    ...l,
    file: relative(tree, isAbsolute(l.file) ? l.file : resolve(tree, l.file)),
  });
  const located = instances.map(at);
  return {
    // Line numbers shift with any edit above a clone; files and sizes don't
    key: located
      .map((l) => `${l.file}#${l.end - l.start}`)
      .sort()
      .join('|'),
    lines: located.reduce((sum, l) => sum + l.end - l.start + 1, 0),
    locations: located.map((l) => `${l.file}:${l.start}-${l.end}`),
  };
}

function measureJscpd(tree: string): Measurement {
  const out = mkdtempSync(join(tmpdir(), 'jscpd-'));
  try {
    execFileSync(
      join(BIN, 'jscpd'),
      [
        // The config's paths resolve against the config file, not the tree
        ...jscpdConfig.path.map((p) => join(tree, p)),
        '--config',
        join(ROOT, '.jscpd.json'),
        '--reporters',
        'json',
        '--output',
        out,
        '--silent',
      ],
      { cwd: tree, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const report = JSON.parse(
      readFileSync(join(out, 'jscpd-report.json'), 'utf8'),
    ) as {
      statistics: {
        total: { percentage: number; duplicatedLines: number; lines: number };
      };
      duplicates: {
        firstFile: { name: string; start: number; end: number };
        secondFile: { name: string; start: number; end: number };
      }[];
    };
    const { total } = report.statistics;
    return {
      percentage: total.percentage,
      duplicatedLines: total.duplicatedLines,
      totalLines: total.lines,
      clones: report.duplicates.map((d) =>
        clone(
          tree,
          [d.firstFile, d.secondFile].map((f) => ({
            file: f.name,
            start: f.start,
            end: f.end,
          })),
        ),
      ),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Duplication CPD finds in the tracked TypeScript files below the configured paths. */
function measureCpd(tree: string): Measurement {
  const pmd = process.env.PMD_BIN ?? 'pmd';
  const sources = execFileSync(
    'git',
    // In a pathspec `*` also matches `/`: these list every file below
    ['ls-files', '--', ...jscpdConfig.path.map((p) => `${p}/*.ts`)],
    { cwd: tree, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  const totalLines = sources.reduce(
    (sum, file) => sum + readFileSync(join(tree, file), 'utf8').split('\n').length,
    0,
  );
  const run = spawnSync(
    pmd,
    [
      'cpd',
      '--minimum-tokens',
      String(jscpdConfig.minTokens),
      '--language',
      'typescript',
      '--format',
      'xml',
      '--no-fail-on-violation',
      ...jscpdConfig.path.flatMap((p) => ['--dir', join(tree, p)]),
    ],
    { cwd: tree, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.error || run.status !== 0) {
    throw new Error(
      `PMD CPD failed (${run.error?.message ?? `exit ${run.status}`}); ` +
        `set PMD_BIN to PMD's bin/pmd.\n${run.stderr}`,
    );
  }
  const covered = new Map<string, Set<number>>();
  const clones: Clone[] = [];
  for (const d of run.stdout.matchAll(
    /<duplication lines="(\d+)"[^>]*>([\s\S]*?)<\/duplication>/g,
  )) {
    const lines = Number(d[1]);
    const instances = [
      ...d[2]!.matchAll(/<file\b[^>]*?\sline="(\d+)"[^>]*?\spath="([^"]+)"/g),
    ].map((m) => {
      const start = Number(m[1]);
      return { file: resolve(tree, m[2]!), start, end: start + lines - 1 };
    });
    for (const { file, start, end } of instances) {
      const set = covered.get(file) ?? new Set<number>();
      for (let line = start; line <= end; line++) set.add(line);
      covered.set(file, set);
    }
    clones.push(clone(tree, instances));
  }
  const duplicatedLines = [...covered.values()].reduce(
    (sum, set) => sum + set.size,
    0,
  );
  return {
    percentage: totalLines ? (100 * duplicatedLines) / totalLines : 0,
    duplicatedLines,
    totalLines,
    clones,
  };
}

function measureFallow(tree: string): Measurement {
  // Exits non-zero when it finds clones; the report is complete either way
  const run = spawnSync(
    join(BIN, 'fallow'),
    [
      'dupes',
      '--root',
      tree,
      '--config',
      join(ROOT, '.fallowrc.json'),
      '--format',
      'json',
      '--quiet',
    ],
    { cwd: tree, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  let report: {
    stats: {
      duplication_percentage: number;
      duplicated_lines: number;
      total_lines: number;
    };
    clone_groups: {
      instances: { file: string; start_line: number; end_line: number }[];
    }[];
  };
  try {
    report = JSON.parse(run.stdout);
  } catch {
    throw new Error(`fallow produced no report:\n${run.stderr}`);
  }
  return {
    percentage: report.stats.duplication_percentage,
    duplicatedLines: report.stats.duplicated_lines,
    totalLines: report.stats.total_lines,
    clones: report.clone_groups.map((g) =>
      clone(
        tree,
        g.instances.map((i) => ({
          file: i.file,
          start: i.start_line,
          end: i.end_line,
        })),
      ),
    ),
  };
}

const measure: Record<Tool, (tree: string) => Measurement> = {
  jscpd: measureJscpd,
  cpd: measureCpd,
  fallow: measureFallow,
};

/** Check out `ref` into a temporary directory and measure it there. */
function measureRef(tool: Tool, ref: string): Measurement {
  const tree = mkdtempSync(join(tmpdir(), 'dup-base-'));
  execFileSync('git', ['worktree', 'add', '--detach', tree, ref], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  try {
    return measure[tool](tree);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', tree], {
      cwd: ROOT,
      stdio: 'ignore',
    });
  }
}

const pct = (n: number) => `${n.toFixed(2)}%`;
const signed = (n: number, format: (n: number) => string) =>
  `${n > 0 ? '+' : n < 0 ? '−' : '±'}${format(Math.abs(n))}`;

function report(
  tool: Tool,
  max: number,
  head: Measurement,
  base: { ref: string; measurement: Measurement } | undefined,
  failures: string[],
): string {
  const lines = [
    `## Duplication: ${tool}`,
    '',
    '| | Duplication | Duplicated lines | Clones |',
    '|---|---|---|---|',
  ];
  const row = (label: string, m: Measurement) =>
    `| ${label} | ${pct(m.percentage)} | ${m.duplicatedLines} / ${m.totalLines} | ${m.clones.length} |`;
  // A commit hash from CI reads better short
  const baseLabel = /^[0-9a-f]{40}$/.test(base?.ref ?? '')
    ? base!.ref.slice(0, 7)
    : base?.ref;
  if (base) lines.push(row(`base ${baseLabel}`, base.measurement));
  lines.push(row('this tree', head));
  if (base) {
    const b = base.measurement;
    lines.push(
      `| change | ${signed(head.percentage - b.percentage, pct)} | ` +
        `${signed(head.duplicatedLines - b.duplicatedLines, String)} | ` +
        `${signed(head.clones.length - b.clones.length, String)} |`,
    );
  }
  lines.push('', `Budget: ${pct(max)} (duplication-budget.json).`, '');

  const list = (title: string, clones: Clone[]) => {
    if (clones.length === 0) return;
    lines.push(`### ${title}`, '');
    for (const c of clones.slice(0, 15)) {
      lines.push(
        `- ${c.lines} lines: ${c.locations.map((l) => `\`${l}\``).join(', ')}`,
      );
    }
    if (clones.length > 15) lines.push(`- … and ${clones.length - 15} more`);
    lines.push('');
  };
  if (base) {
    const known = new Set(base.measurement.clones.map((c) => c.key));
    list(
      'New clones',
      head.clones.filter((c) => !known.has(c.key)),
    );
  }
  list(
    'Largest clones',
    [...head.clones].sort((a, b) => b.lines - a.lines),
  );
  if (failures.length > 0) {
    lines.push('### Failed', '', ...failures.map((f) => `- ${f}`), '');
  }
  return lines.join('\n');
}

function main(): void {
  const [tool, ...rest] = process.argv.slice(2);
  if (!TOOLS.includes(tool as Tool)) {
    console.error(
      `usage: node scripts/duplication.ts <${TOOLS.join('|')}> [--base <ref>]`,
    );
    process.exit(2);
  }
  const which = tool as Tool;
  const baseIndex = rest.indexOf('--base');
  const baseRef = baseIndex === -1 ? undefined : rest[baseIndex + 1];

  const budget = JSON.parse(
    readFileSync(join(ROOT, 'duplication-budget.json'), 'utf8'),
  ) as Budget;
  const max = budget.maxPercentage[which];

  const head = measure[which](ROOT);
  const base = baseRef
    ? { ref: baseRef, measurement: measureRef(which, baseRef) }
    : undefined;

  const failures: string[] = [];
  if (head.percentage > max) {
    failures.push(
      `duplication ${pct(head.percentage)} exceeds the budget of ${pct(max)}`,
    );
  }
  // New duplication means more duplicated lines and a larger share of the
  // code: a change that adds much code and a little duplication can lower the
  // share, and one that edits inside a clone can change its size.
  const b = base?.measurement;
  if (
    b &&
    head.duplicatedLines > b.duplicatedLines &&
    head.percentage > b.percentage
  ) {
    failures.push(
      `duplication grew from ${pct(b.percentage)} to ${pct(head.percentage)} ` +
        `(${b.duplicatedLines} → ${head.duplicatedLines} duplicated lines) ` +
        `compared with ${baseRef}`,
    );
  }

  const summary = report(which, max, head, base, failures);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  for (const f of failures) {
    console.log(`::error title=Duplication (${which})::${f}`);
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

main();
