@AGENTS.md

# Claude Code specifics

- `claude-code/*` plugins are Claude Code **mods** (function-hook plugins): `hooks/hooks.json`
  names one TypeScript module exporting `register(on, options)`. The API reference is the bundled
  `plugin-authoring` skill: load it (Skill tool or `/plugin-authoring`) and read its
  `reference.md` and `types/claude-code.d.ts` (search for `'session.compact'`,
  `SessionCompactInput`, `SessionMessage`, `ModelCompleteRequest`). Once a mod is loaded, the
  engine also writes editor types to `<plugin>/.claude-plugin/types/`.
- Before committing a plugin change, run both and keep them clean:
  - `claude plugin validate .` (reads the marketplace, manifests and modules)
  - `claude plugin test claude-code/custom-compaction` (unit tests; a test's hooks stand in for
    the engine, and a stand-in for a `$` call answers `{ value }`)
- Try a change in a session with `claude --plugin-dir claude-code/custom-compaction`.
- The plugin directory checks in `claude plugin validate` want a license (root `LICENSE`, MIT)
  and may warn about a missing icon.
