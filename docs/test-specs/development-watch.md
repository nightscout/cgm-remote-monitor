# Development watch review (M24)

Proposal: retain nodemon 3.1.14 for `dev` and `dev-test` in this modernization
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

Both restart the application module with updated exports and expose a new live
Node inspector target after each cycle. This verifies inspector discovery, not
an actual VS Code debugger reconnect. No unexpected extra restart occurred in
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
framework to remove one development dependency. Retaining it is the simpler
proposal until native watch can meet these contracts on every supported platform.

Remaining before closing M24: hosted Linux comparison, explicit Windows/IDE
validation or a documented release gate, and final review of the retain decision.
Revisit when Node supports the required ignore/watch policy portably or the
project explicitly changes its development restart contract. No package/runtime
change is made by this review, and M24 remains unchecked pending those gates.
