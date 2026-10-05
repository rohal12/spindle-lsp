#!/bin/bash
# Run the normal suite and typecheck against one published @rohal12/spindle
# version without touching the repo's node_modules.
#   scripts/peer-matrix.sh <spindle-version> [scratch-dir]
# Builds <scratch>/run/<version>: a copy of the sources whose node_modules is a
# real directory of symlinks to the repo's, except @rohal12/spindle, which is
# the packed release (tests import its src/ by relative node_modules path).
# Writes out.json (vitest), out.log and tsc.log there.
set -u
v=${1:?spindle version}
root=$(git rev-parse --show-toplevel)
nm=$(readlink -f "$root/node_modules")
scratch=${2:-${TMPDIR:-/tmp}/spindle-peer}
pk=$scratch/pk/$v
d=$scratch/run/$v
mkdir -p "$pk"
[ -d "$pk/package" ] || (cd "$pk" && npm pack "@rohal12/spindle@$v" --silent >/dev/null && tar xzf ./*.tgz)
rm -rf "$d"; mkdir -p "$d/node_modules/@rohal12"
(cd "$root" && cp -r src test package.json esbuild.config.ts tsconfig.json vitest.config.ts vitest.review.config.ts "$d/")
for e in "$nm"/* "$nm"/.bin; do
  n=$(basename "$e"); [ "$n" = @rohal12 ] || ln -s "$e" "$d/node_modules/$n"
done
for e in "$nm"/@rohal12/*; do
  n=$(basename "$e"); [ "$n" = spindle ] || ln -s "$e" "$d/node_modules/@rohal12/$n"
done
cp -r "$pk/package" "$d/node_modules/@rohal12/spindle"
cd "$d"
npx vitest run --reporter=json --outputFile="$d/out.json" >"$d/out.log" 2>&1
npx tsc --noEmit >"$d/tsc.log" 2>&1; echo "tsc=$?" >>"$d/tsc.log"
node -e "const r=require('$d/out.json');console.log('$v',r.numPassedTests+'/'+r.numTotalTests,'tsc',require('fs').readFileSync('$d/tsc.log','utf8').trim().split('\n').pop())"
