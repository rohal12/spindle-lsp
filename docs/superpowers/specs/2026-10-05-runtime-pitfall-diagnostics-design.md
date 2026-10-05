# Runtime Pitfall Diagnostics — Design Spec

**Date:** 2026-10-05
**Spindle behaviour checked against:** `@rohal12/spindle` 0.44.0 source

## Problem

Some Spindle markup parses cleanly and passes every existing check, but it does
the wrong thing at runtime without any error. Four such cases showed up as real
bugs in a game built on Spindle:

- a `_temporary` assigned inside a `{for}` loop, so every iteration shows the
  last iteration's value;
- `{include}` of a `[widget]` passage, which renders nothing;
- `$flags.name` where `$flags` is declared as an array, which is always
  `undefined`;
- widgets that are defined but never used.

This spec adds one diagnostic for each case.

| Code    | Name                      | Severity | Summary                                                        |
| ------- | ------------------------- | -------- | -------------------------------------------------------------- |
| `SP205` | `TemporaryAssignedInLoop` | warning  | `_temp` assigned inside `{for}` and read in the loop body      |
| `SP206` | `ArrayMemberAccess`       | warning  | `$var.name` / `%var.name` on a variable declared as an array   |
| `SP302` | `IncludeWidgetPassage`    | warning  | `{include}` of a `[widget]` passage that defines widgets       |
| `SP303` | `UnusedWidget`            | hint     | widget defined but never invoked anywhere in the workspace     |

## SP205 — temporary assigned inside `{for}`

### Spindle behaviour

- `{computed _x = …}` writes through `state.setTemporary()` (`Computed.tsx`), and
  `{set _x = …}` writes through `executeMutation()`, which also calls
  `setTemporary()` (`execute-mutation.ts`). Temporaries live in a single
  store-wide map (`store.ts`), which is reset on navigation.
- `{for}` gives each iteration its own locals scope (`ForIteration` in
  `For.tsx`, through `LocalsUpdateContext`). `{computed @x}` and `{set @x}`
  write to that scope, so `@` variables are per iteration.

Every iteration therefore writes the same `_x`. Once the passage re-renders,
every iteration reads the value written by the last one: every row of a list
shows the same item.

### What is reported

A plain assignment to `_name` (target of `{computed _name = …}`, or
`_name = …` inside `{set}`) when all of the following hold:

1. the macro is inside a `{for}` body in the same passage;
2. no `{link}` or `{button}` lies between the assignment and that `{for}`.
   Their bodies run on click (`renderChildrenDetached` in `MacroLink.tsx` /
   `Button.tsx`), and recording the clicked iteration's value in a temporary
   is a normal way to pass it out of the loop;
3. `_name` is read somewhere else in the body of the innermost enclosing
   `{for}`. Occurrences that are themselves plain assignment targets do not
   count as reads.

The `{computed}` target is located exactly as Spindle's `parseComputedArgs()`
locates it. In `{set}`, string contents are ignored, but code inside template
`${…}` interpolations is analysed, because Spindle's `transform()` converts
sigils there too.

### What is not reported

- `@locals` assigned in a loop.
- Temporaries read only after the loop, such as
  `{if @x.bad}{set _anyBad = true}{/if}`, or "last item" captures. These are
  deliberate ways to hand a value out of a loop, and changing them to `@` would
  break them.
- Accumulators: compound operators (`_n += 1`), `++` / `--`, and assignments
  whose right-hand side reads the same temporary (`_total = _total + @x.cost`).
- Member assignments (`_obj.field = …`) and assignments inside `{do}` blocks.

### Example

```
{for @i of $slots}
  {computed _b = $buildings[@i]}   ← SP205: use @b
  {_b.name}
{/for}
```

Fix: `{computed @b = $buildings[@i]}` and `{@b.name}`. If the value does not
depend on the iteration, assign it once before the loop instead.

## SP206 — member access on an array variable

### Spindle behaviour

`parseStoryVariables()` (`story-variables.ts`) evaluates each default and
records `type: 'array'` for arrays. Its own reference check skips field access
on arrays entirely ("any field access on an array is allowed"). Expressions
compile `$flags.x` to `variables["flags"].x` (`expression.ts`), a plain
JavaScript property read. For a name that arrays do not have, that read is
always `undefined`.

### What is reported

`$var.member` (or `%var.member`) where:

- the variable's default in `StoryVariables` (or `StoryTransients`) is a
  single array literal (`[]`, `["a", "b"]`). The LSP does not evaluate story
  code; `inferLiteralType()` recognises a literal only when its closing bracket
  ends the expression, so `[1, 2].length` or `makeList()` get no type and are
  never reported;
- `member` is not an array property. The check covers own and inherited
  members of `Array.prototype`, plus recent methods (`at`, `toSorted`, `with`,
  …) that the LSP's Node runtime may lack.

Every occurrence is reported, including assignments such as
`{set $flags.seen = true}`. The message suggests
`$var.includes("member")`, the usual intent when an array is used as a set of
flags.

### What is not reported

Nested paths (`$pc.tags.foo` where `tags` is an array inside an object
default). The LSP only types top-level defaults. Numeric and bracket access
(`$list[0]`) is not reported either.

## SP302 — `{include}` of a `[widget]` passage

### Spindle behaviour

- At startup, Spindle registers every `{widget}` definition in passages tagged
  `widget` (`index.tsx`, passes 1 and 2).
- `{include}` (`Include.tsx`) evaluates its arguments, minus an `inline`
  keyword, as an expression. If evaluation throws, it uses the raw text with
  surrounding quotes stripped, so a bare `{include ActResist}` still resolves
  to the passage `ActResist` (via a `ReferenceError`). It then renders the
  passage's content.
- When rendered, the `Widget` macro (`Widget.tsx`) only re-registers the
  widget and returns `null`.

Including a widget passage therefore produces none of its widgets' output.

### What is reported

An `{include}` whose target is statically known and names a passage tagged
`widget` that contains at least one `{widget}` definition (quoted or bare name,
matched like Spindle's startup scan). The target is statically known when it
is:

- a string literal (`"Name"`, `'Name'`, or a backtick literal without `${}`);
- a bare name with no sigils, quotes or calls, which Spindle resolves through
  the fallback described above. The helper functions Spindle's expression
  preamble defines (`visited`, `random`, …) are excluded, because they
  evaluate to functions.

The message lists the widgets the passage defines and suggests invoking one
of them (`{ActResist}`).

### What is not reported

- Dynamic targets (`{include $name}`, `{include _p}`, concatenations, calls).
- `[widget]`-tagged passages without any `{widget}` definition. Their content
  renders normally when included, for example a passage that only holds a
  `{do}` block.

## SP303 — unused widget

### What is reported

A widget registered by the LSP's `WidgetRegistry` that no document in the
workspace opens as a macro (`{name …}`, `{.class name}`, or the opening tag of
a block widget). Names are compared case-insensitively, like Spindle's
`getWidget()`. The diagnostic is reported on the widget definition, in the
document that defines it.

Invocations are recorded per document during the workspace cascade, from the
same `parseMacros()` pass the variable tracker already uses
(`WidgetRegistry.recordInvocations()` / `isInvoked()`), so this adds no extra
parsing.

### Severity

Hint. The LSP cannot see markup that JavaScript builds and renders at
runtime, and files outside the checked set or workspace are not scanned.
`spindle-lsp check` shows hints only with `--severity hint`.

## Implementation notes

- All four checks live in `plugins/diagnostics.ts`. Each runs in its own
  `try` block, like the existing checks.
- `MacroNode.rawArgs` comes from text in which `{$var}`-style interpolations
  were blanked out, which also blanks `${_x}` inside template literals. SP205
  and SP302 therefore read the arguments from the original document text,
  using the macro range (`sourceArgs()`).
- `buildLineStarts()` and `offsetToPosition()` are now exported from
  `core/parsing/macro-parser.ts`, so SP205 can report the exact range of the
  `_name` token.
- `DeclaredVariable.type` (`VariableValueType`) is set only when the default
  is a single literal.
