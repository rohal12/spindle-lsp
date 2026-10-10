# Migration to the Spindle tooling API (0.59.x)

Status: in progress. spindle-lsp's minimum Spindle is 0.59.20 (devDependency
0.59.23). Its parsing is being moved from hand-written mirrors of the runtime's
rules onto `@rohal12/spindle/tooling` (see `docs/tooling.md` in Spindle).

## Runtime changes since the 0.45.1/0.51.3 audit that change contracts

- `{goto}`, `{include}`, `{link}` take a `passage` argument: a quoted string is
  a name (read as a JavaScript literal, `passageTarget`), anything else is an
  expression evaluated at run time (`evaluatePassageName`). **There is no text
  fallback**: a bare name (`{goto Old}`) is an expression and throws a
  ReferenceError (Spindle reports `unquoted-passage-name`).
- `{include}`'s `inline` flag: `splitIncludeFlag` (first or last word outside
  quotes and brackets).
- Code is read with acorn at story start (`code-syntax` diagnostics).

## Cell dispositions

(cells whose expectation encoded runtime behavior that no longer exists are
listed here with the runtime evidence; none is deleted or skipped.)
