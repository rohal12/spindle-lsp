# Vendored Spindle 0.51.3 sources

Test oracles copied from the published npm package `@rohal12/spindle@0.51.3`
(`https://registry.npmjs.org/@rohal12/spindle/-/spindle-0.51.3.tgz`, the
`package/src/` tree). Spindle is released under the Unlicense (SPDX
`Unlicense`, the `license` field of the package's `package.json`; the package
ships no separate LICENSE file), a public-domain dedication that allows
copying, modification and redistribution without conditions.

| File here | Origin in the package | Changes |
| --- | --- | --- |
| `tokenizer.ts` | `src/markup/tokenizer.ts` | none: byte-identical to the package |
| `story-variables.ts` | `src/story-variables.ts` | the file's leading comment and its first two lines, which imported `Passage` from `./parser` and `tokenize` from `./markup/tokenizer`, are replaced by that comment, `import { tokenize } from './tokenizer'` and a local `Passage` interface (`name`, `tags`, `content`); the rest is byte-identical |

Why they are here: the suite runs against whichever Spindle is installed
(0.45.1 by default, any release from 0.43.0 through `scripts/peer-matrix.sh`),
which leaves behaviors that only newer releases have without an always-on
oracle: startup validation that reads only executable references (0.50.1 and
later) and a tokenizer that skips string literals when it looks for a macro's
closing brace and keeps `{do}` bodies as raw text (0.50.1 and later). Tests that
use them: `test/unit/executable-refs.test.ts`,
`test/unit/macro-head-differential.test.ts`.

## Refreshing

Do this when a newer release changes tokenizing or startup validation and the
tests should follow it (bump the version in this directory's name, in the
header comment of `story-variables.ts` and in the imports that name it):

```sh
cd "$(mktemp -d)"
npm pack @rohal12/spindle@<version>      # writes rohal12-spindle-<version>.tgz
tar xzf rohal12-spindle-<version>.tgz     # unpacks to ./package
D=<repo>/test/fixtures/spindle-<version>
cp package/src/markup/tokenizer.ts "$D/tokenizer.ts"
cp package/src/story-variables.ts "$D/story-variables.ts"
# re-apply the two import changes to story-variables.ts and keep the header comment
diff package/src/markup/tokenizer.ts "$D/tokenizer.ts"        # must print nothing
diff package/src/story-variables.ts "$D/story-variables.ts"   # only the header/imports
```

Then run `npm test`, `npm run typecheck` and the boundary releases of the
peer matrix (see `docs/reviews/process.md`). The files are test data: do not
edit them to make a test pass; to change behavior, refresh from a release.
