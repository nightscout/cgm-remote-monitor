# Native boot sequence (M18, second slice)

`lib/utils/boot-sequence.js` replaces the bootevent/chainsaw queue used by
`lib/server/bootevent.js`. The application registers the same fourteen stages
in the same order. Construction schedules startup on the next tick; stages
share one context and advance only through their callback. The existing
`.boot(callback)` entry point and context-only callback remain unchanged.

Recoverable boot failures still live in `ctx.bootErrors`; later stages use
those errors to skip storage, authorization and connector startup. Fatal
synchronous errors still escape, including the minimum Node version check.
The local helper rejects duplicate stage callbacks. It does not recreate
unused bootevent APIs such as tap, fail, context replacement or nested chains.

The characterization tests in `tests/boot-sequence.test.js` can also run against
an installed parent using `NIGHTSCOUT_BOOT_ORACLE=/parent/node_modules/bootevent`.
They verify deferred startup, asynchronous gating, independent contexts and
recorded errors across two sequences, and empty completion. The native-only
case rejects duplicate advancement. `tests/boot-sequence-integration.test.js`
executes two real failed Nightscout boots and tears down each heartbeat bus;
it checks that neither storage nor connectors start after a configuration
error. Existing connect lifecycle and Axios settings-import tests now capture
the registered stage array instead of mocking the removed package's chain.

Validation in progress:

- Seven characterization cases pass with old and new helpers together.
- Forty focused helper, real failed-boot, connector and Axios cases pass on
  Node 22.23.2 and 24.20.0. Lint has no errors and one dynamic test-oracle warning.
- A clean Node 22 install/build succeeds. All six generated production JS
  bundles are byte-identical to the validated M16 implementation build.
- The lockfile removes bootevent, chainsaw and chainsaw's private traverse:
  three paths, 102,370 installed regular-file bytes, no changed retained paths.
  This is not a measurement of retained server-memory savings.
- Full backend and hosted CI validation are still required before merging.

M18 also requires the separate async replacement in #8639. This slice alone
does not complete M18 or the combined modernization plan in #8605.
