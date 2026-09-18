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
