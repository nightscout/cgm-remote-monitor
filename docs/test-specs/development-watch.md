# Development watch review (M24)

Decision: retain nodemon 3.1.14 for `dev` and `dev-test` in this modernization
release. The registry reports that version as current on 2026-09-06. The native
environment runner has already removed env-cmd; npm start never invokes nodemon,
so removing this development tool would not reduce server runtime memory.

The current nodemon configuration ignores tests, node_modules and bin. In owned
fixtures on Node 22.23.2 and 24.20.0, two update cycles show:

| Changed file | nodemon restarts | Native watch restarts |
| --- | --- | --- |
| tests/ignored.js | 0 | 0 |
| bin/ignored.js | 0 | 0 |
| static/unimported.js | 1 | 0 |
| Imported node_modules dependency | 0 | 1 |
| Imported lib module | 1 | 1 |

Both restart the application module with updated exports. The strengthened
probe connects to each new inspector over its WebSocket protocol and evaluates
process.pid, verifying the reply identifies the restarted child. This tests
debugger attachment after restart, not VS Code UI automation. No unexpected extra restart occurred in
the bounded 1.5-second observation windows; this is not a general stress or
network-filesystem guarantee. Initial probes without explicit child-runtime
pinning were discarded; recorded probes assert each child uses the chosen Node.

`tools/probe-development-watch.py` uses temporary owned files and process groups,
loads the repository's nodemon ignore configuration explicitly, and cleans up
children and files. It never starts Nightscout or accesses a database. The Node
regression runs the same comparison on POSIX CI; Windows is skipped explicitly.
The raw local measurements are in `../audits/development-watch.json`.

Node's [watch documentation](https://nodejs.org/docs/latest-v22.x/api/cli.html#--watch)
describes module-based default watching. Explicit watch paths have platform
limits; a drop-in switch cannot be assumed to preserve our Linux workflow or
ignore policy. [Nodemon's documented configuration](https://github.com/remy/nodemon)
supports those ignores and broader application-file watching. Reimplementing
that policy, process lifecycle and platform behavior locally would add a watcher
framework to remove one development dependency. Retaining it preserves the existing workflow with less local code until native
watch can meet these contracts on every supported platform.

The previous head passed every hosted check, including the Linux watch-policy
comparison. Fresh hosted checks are required for the strengthened debugger probe
and integration refresh before merging. No Windows watch implementation or
package script changes are introduced by retaining nodemon; the overall Node
runtime rollout still has its separate hosting/Windows release gates.
Revisit when Node supports the required ignore/watch policy portably or the
project explicitly changes its development restart contract. No package/runtime change is made by retaining nodemon. Together with the
merged environment-runner work, this completes the M24 implementation decision;
the candidate must pass its fresh CI before integration.

## Addendum 2026-10-27: watch an allowlist, keep nodemon

nodemon now watches only the paths the server loads from the repository:
`lib`, `views`, `translations`, `webpack` and `package.json`. Before, it watched
everything except tests, node_modules and bin. The decision to retain nodemon
is unchanged.

The reason is the per-user Linux limit on file watches (inotify). On
2026-10-26 this test failed with `ENOSPC: System limit for number of file
watchers reached`, which is that limit, not a full disk. Counted from
`/proc/<pid>/fdinfo` on Linux with nodemon 3.1.14 and Node 22.23.4, at `dev`
`2dc0c1bc` with node_modules installed:

| nodemon configuration | inotify watches |
| --- | --- |
| ignore tests, node_modules, bin (before) | 1,502 |
| watch lib, views | 345 |
| watch lib, views, translations, webpack, package.json (now) | 385 |
| watch lib, views, static | 586 |

- **`translations`, `webpack` and `package.json`** are watched because the
  server reads them at startup: `lib/server/server.js` loads the localization,
  `lib/server/app.js` requires the webpack configuration, and
  `lib/server/env.js` reads `package.json`.
- **`static/` is left out.** `lib/server/app.js` serves it as files, with
  `maxAge: 1` (one millisecond) in development, and in development
  webpack-dev-middleware rebuilds the client bundle inside the running server. A restart on a
  `static/` edit therefore did nothing useful.
- **Native watch was not chosen.** Scoped the same way,
  `node --watch-path=lib --watch-path=views` costs 346 watches, as much as
  nodemon. Switching would reopen the questions this
  decision answered: ignore rules, Windows, and the debugger reattaching after a
  restart.

The owned fixture now also has `views`, `translations` and `docs` files. In
two update cycles, nodemon restarts for `lib`, `views` and `translations`, and
not for `docs`, `static`, `tests`, `bin` or node_modules. Native watch still
follows the module graph. With the previous configuration and these
expectations, the test fails at `docs/unlisted.js`. The raw sample is
`watchAllowlist` in `../audits/development-watch.json`.
