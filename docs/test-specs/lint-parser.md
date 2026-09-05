# ESLint parser simplification

M11 removes the `babel-eslint` declaration and selects ESLint 7's existing default Espree parser. Explicit ECMAScript 2020 and module parsing cover the application's current syntax. Babel core, preset and loader remain responsible for browser transpilation; no emitted application code changes in this step. Future syntax additions beyond the installed Espree version need the separate ESLint/toolchain review, not a parser-suppression rule.

The actual `eslint lib` JSON results were compared across all 215 files at modernization parent `8b57b7b8`. Babel ESLint and Espree produced identical message objects, including rule, severity, position, message and suggestions: five existing errors, 16 warnings and no parse failures. The errors are four unused variables (`lib/api/profile/index.js`, `lib/api3/alarmSocket.js`, `lib/profile/profileeditor.js`, `lib/server/server.js`) and one existing constant condition (`lib/storage/mongo-storage.js`). This is lint parity, not a claim that the repository's full lint command is clean. No rule, global, environment, override or suppression changes.

To reproduce, run the same command in clean built parent/candidate worktrees, then compare each file's relative `lib/` path and complete `messages` array. Preserve exit status/output; the existing errors make both commands exit 1.

```sh
node node_modules/eslint/bin/eslint.js lib --format json --output-file /path/to/results.json
```

Clean locked install and production/development builds passed. The development webpack build exercises `eslint-webpack-plugin` and preserves its existing warnings. Lockfile regeneration removes only `node_modules/babel-eslint`; all retained package entries, including the production graph, are unchanged. Transitive Babel parser packages remain required by other tooling. Final refreshed integration CI and bundle-byte comparison remain required before merge. No runtime-memory saving is claimed for this development-only removal.

The supported parser-option values are documented by [ESLint 7](https://github.com/eslint/eslint/blob/v7.32.0/docs/user-guide/configuring/language-options.md#specifying-parser-options). Rollback the manifest/lockfile and `.eslintrc.js` change together, then run a clean locked install. No data, browser storage, deployment configuration or UI behavior changes.
