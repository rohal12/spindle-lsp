# StoryData diagnostics

StoryData is compiler metadata. Checks in the editor, CLI and MCP report
invalid metadata and unusable entry passages as errors:

| Code | Meaning |
| --- | --- |
| SP003 | The compiler rejects explicit StoryData: malformed JSON, invalid field types or an invalid IFID. |
| SP004 | The effective starting passage is missing or the compiler omits it from story data. |

Metadata errors point to the StoryData body. Entry errors point to the
StoryData passage name for an explicit selection, or to an implicit Start
that the compiler omits (for example, one tagged `script`). They clear after
metadata or destination roles are repaired, including unsaved edits and
replacements in other files. CLI checks exit with status 1 for these errors.

Every source StoryData body is validated, including declarations replaced
later in the same file or another file. Replacement selects the effective
format, version and entry; it does not erase errors in earlier source bodies.

Metadata decoding uses the compiler's case folding, repeated-field, null and
replacement semantics. Partial metadata does not require an IFID or an explicit
entry selection just for editor checks.
