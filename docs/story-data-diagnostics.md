# StoryData diagnostics

StoryData is compiler metadata. Checks in the editor, CLI and MCP now report
missing explicit entry passages as errors:

| Code | Meaning |
| --- | --- |
| SP004 | The effective StoryData selects a starting passage that does not exist in the complete workspace. |

The error points to the StoryData passage name. It clears after the entry
selection is repaired or the missing destination is restored, including
destinations in other files. CLI checks exit with status 1 when it is present.

Metadata decoding uses the compiler's case folding, repeated-field, null and
replacement semantics. Partial metadata does not require an IFID or an explicit
entry selection just for editor checks.
