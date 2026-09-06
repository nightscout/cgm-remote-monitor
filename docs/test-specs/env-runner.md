# Environment-file runner

The first M24 slice removes env-cmd from repository scripts. A scoped Node
runner starts only Node entry points, using the current Node executable,
explicit script paths, inherited stdio and file-overrides-environment merging.
It passes Node flags, arguments and NODE_OPTIONS before child startup, forwards
SIGINT/SIGTERM/SIGHUP and waits for child exit. Child exit status or termination
signal is propagated. Nodemon remains installed for the separate watch slice.

Native --env-file is not a compatible drop-in here. Owned probes against
Node 22.23.2 and env-cmd 10.1.0 show that unquoted # characters, single-quoted
escaped newlines, literal multiline values, export syntax and precedence differ.
To avoid changing existing configuration, this runner retains the existing
.env grammar and file-wins precedence. A small parser is adapted with the
original MIT notice; there is no shell execution or generalized command lookup.
JSON/JavaScript env-cmd configuration, rc files and expansion switches are not
repository-script features and are not recreated.

Seven recorded grammar examples pass against both the installed parent parser
and the replacement. Process tests cover spaces/literal arguments, inherited
values, file-wins precedence, startup NODE_OPTIONS, explicit Node flags, nonzero
exit codes, missing files, nyc/Mocha children and two termination cycles.
All 19 comparison/process cases pass on Node 22.23.2 and 24.20.0. Signal tests
are POSIX-specific; Windows skips that one case and retains the other checks.
Clean installation/build passes. Full suite invocation through the actual
runner and hosted Linux validation remain required.

All package scripts keep their names and existing file paths. For a direct
command, use `node bin/with-env.js FILE NODE_ENTRY [ARGS]`; for example,
`node bin/with-env.js my.prod.env lib/server/server.js`. Node options go before
the entry point. Missing files fail without running the child; configuration
values are not printed. The helper is shipped with the repository's bin files.

The lockfile removes env-cmd and its private commander package, with no changes
to retained entries. Removed regular-file contents total 139,284 bytes, counting
the nested commander files only once. The runner is not a server-memory optimization: npm start
already invokes the server directly. Rollback restores package scripts and the
manifest/lockfile together, then removes the helper.

The first full covered run exposed a real signal-exit race: the new wrapper
could exit naturally with code zero after its child closed, before its own
SIGTERM was delivered. The old runner retained SIGTERM under the same probe.
The signal path now holds the event loop briefly until delivery, matching the
usual foreground-child pattern. Both old and new now report SIGTERM under
coverage. The unchanged 12 native cases pass under nyc on Node 22 and 24;
the normal old/new comparison has 19 cases. The full covered suite is rerun
before considering the candidate ready.
