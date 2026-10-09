# Proposed migrations (NOT applied, NOT in db/migrations)

**None.** No schema change was needed for any Claude workstream (A–F). Migration 030 is applied in production and is untouched
(byte-pinned by a test); Messaging Terms/Privacy are created at runtime by the editor, not by SQL.

Other proposals in this folder are build fixes for ChatGPT-owned files, see `BUILD_BLOCKERS_CP08.md`.
