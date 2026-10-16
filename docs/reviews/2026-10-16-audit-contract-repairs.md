# October 16 audit contract repairs

The clean baseline was `d4f565189775188a392c0c7c6ba2b6ee45b6765d`,
spindle-lsp 0.9.0, Node 22.18.0 and installed/bundled Spindle 0.60.3.
The requested seven findings were reproduced existing defects; introduction
was not established. No open PR covered this work. Main now includes that
baseline through merged PR #111; this repair uses `fix/audit-contract-gaps`.
Issue bodies were snapshotted before implementation. The baseline passed
`TMPDIR=/var/tmp npm test` (2,296 unit/integration tests in 80 files and
6,284 convergence cells in 18 shards) and typecheck.

## Dispositions and retained evidence

| Owner | Disposition and evidence |
| --- | --- |
| #66 | Repaired: formatting dispatch preserves non-markup payloads rather than sending them through prose wrapping. Tagged script/style still use Spindle's formatter. `FORMAT-ROLE` retains declarations for both sigils, StoryData JSON, SaveTitle code and StoryTitle text across LF/CRLF, with exact payload/idempotence and ordinary prose-wrapping controls. Bundled CLI tests exercise the width option and subsequent `check`. |
| #108 | Repaired: variable extraction and declaration quick fixes use indexed passage bodies, removing both old whitespace-required boundary scans. `HEADER/declare-*` applies edits and reparses declarations over both sigils, compact/spaced headers, LF/CRLF, other-document destinations, EOF/header-only/adjacent passages and unchanged next-passage content. Framed LSP applies the quick fix and verifies SP200 clears after didChange. |
| #112 | Repaired: retain each opaque runtime widget definition and pass it as `ToolingMacro.widget`, with actual macros taking precedence. Invalidate discovery markup before scanning usages with the new definitions. `WIDGET-HOLDS` covers passage/expression/statements/markup roles and text/unannotated controls, same/cross-file, labels/attributes, both variable sigils, diagnostics, passage definition, references, prepareRename, applicable lenses and applied/rebuilt renames. Annotation edits, removal and same-named discovered macros are retained state controls. Variable go-to-definition and transient lenses were not baseline capabilities and are not added. Framed LSP verifies passage references, definition and applied rename. |
| #113 | Repaired: CLI and MCP share exact-file-before-glob resolution, preserving directory and genuine pattern inputs. `CLI-PATH` runs check/format-check/format on bracketed names/directories, spaces, ordinary paths, relative/absolute paths, real globs and overlapping inputs. Write tests check intended output and unchanged nearby glob-matching files. Existing MCP directory tests remain controls. |
| #114 | Repaired: the LSP-owned Twee header parser consumes name, tags and metadata once instead of retrying optional regex groups. `HEADER/adversarial-*` uses bounded subprocesses at 40/160 KB for unterminated tags, metadata and mixed delimiters, plus ordinary and escaped-name controls. Framed LSP sends a request immediately after opening the adversarial file and checks responsiveness. Existing BOM/compact/escaped/tag/meta/UTF-16 controls remain enabled. |
| #115 | Repaired: preflight batch reads fail explicitly before analysis or writes. CLI failures include path/reason and exit 2; CLI formatting continues past individual write failures but returns 2. MCP throws with the failed path, which the SDK exposes as `isError`, rather than returning successful counts. `FILE-IO` exercises all three operations through real CLI and MCP transports, read/write EACCES, mixed batches, success and no-match controls. Permission fixtures drop root privileges when necessary. Failed writes leave the failed file unchanged; a read failure leaves every input unchanged. Earlier successful writes in an MCP batch are not rolled back if a later write fails. |
| #107 | **Needs upstream API; remains open.** The public lexer reports occurrences without read/write roles. Distinguishing nested destructuring writes from defaults/computed keys requires a parsing API. Filed [rohal12/spindle#574](https://github.com/rohal12/spindle/issues/574) with array/object patterns and genuine-read controls. No ad-hoc write scanner, internal-source import, disabled SP205 check or weakened true-read assertion is introduced. The existing warning on write-only destructuring therefore remains until that API is released and consumed. |

The widget runtime already provides its parameter-role metadata in 0.60.3;
its published declaration file omits those fields. The registry preserves the
complete returned object without interpreting annotations. Upstream #574 also
requests the missing public types. No dependency update is required for the
six repairs. The parsing ownership follow-up is recorded in the
[migration ledger](2026-10-10-tooling-migration.md).

## Verification

The shared audit tables extend the existing repair-contract and public-entrypoint
families. The matrix adds **198 cells**, preserving every previous identity and
state: 6,469 applicable passes and 13 historical not-applicable cells, with no
failures, unrun cells, new skips or expected-failure assertions. The golden
results were regenerated with `REVIEW_WRITE_RESULTS=1 npm run review:convergence`
and then checked by the ordinary gate without write mode.

Selected final tests were also run with baseline production source temporarily
restored, then the repairs were restored in a finally block. Four unit contracts
failed for width corruption, compact declaration insertion and dropped widget
passage metadata. Four public cells failed for literal CLI paths, swallowed read
errors, the four-second parser timeout and widget LSP references. They pass with
the repair. All retained neighboring contracts remain in the normal gate.

Final checks on the repaired source:

- `TMPDIR=/var/tmp npm test`: exit 0, **2,494 unit/integration tests in 80 files**
  and **6,482 convergence cells in 18 shards**.
- `npm run typecheck` and `npm run build`: exit 0.
- `npm run duplication` and all three `--base d4f5651` comparisons: exit 0,
  without increasing budgets.
- `claude plugin validate .`: passes; existing warning about the deliberately
  unversioned latest-release plugin remains.
- `git diff --check`: clean.

| Scanner | Baseline | Repair | Duplicated lines, baseline → repair |
| --- | --- | --- | --- |
| jscpd | 2.48% | 2.25% | 254 → 229 |
| PMD CPD | 4.00% | 3.54% | 412 → 362 |
| fallow | 9.88% | 9.70% | 1,007 → 982 |

This is a bounded repair of six findings. It does not close #107 or claim
complete JavaScript read/write analysis. The fixing PR and commit are linked
through the six issue closure references in the PR.
