# Native callback task migration (M18, first slice)

Replace the direct `async` 0.9 dependency with the array-only helper in
`lib/utils/callback-tasks.js`. Consumers are dataloader, treatment pre-bolus
writes, Maker, Alexa and Google Home. This slice does not replace `bootevent`;
boot ordering, failure and repeated boot/teardown coverage remain M18 work.

The helper preserves ordered results, synchronous and empty completion,
multiple callback values, sequential writes and the ten-handler voice limit.
It avoids a Promise per task and handles 10,000 synchronous sequential items
without recursive stack growth. The first error completes once and stops
unscheduled tasks; already running tasks are not cancelled. A task that throws
synchronously stops the run as `async` did: the error reaches the caller, no
later task starts, and completion is not reported when an earlier task calls
back. Duplicate task
callbacks throw rather than advancing the queue twice.

Two intentional corrections accompany the replacement:

- Maker finishes all keys in one stage before beginning the next. Previously,
  each key invoked the stage callback independently, advancing stages early.
  Keys start independently within a stage, and a failure does not suppress
  other keys or later stages. The first error is reported once after all stages
  complete. Each HTTPS request has a ten-second absolute deadline, covering
  connection setup and response-body completion, and destroys the request on
  failure. Successful results retain configured key order.
- Voice rollups omit missing results when a handler fails, returning available
  completed text once instead of throwing while accessing an undefined result.

`tests/callback-tasks.test.js` covers helper contracts. Set
`NIGHTSCOUT_ASYNC_ORACLE` to a parent checkout's installed `async` directory to
run the five shared characterization cases against both implementations.
`tests/plugin-task-order.test.js` exercises two successive Maker events,
stage barriers, partial failures, announcement keys and voice rollups.
`tests/maker-delivery.test.js` uses an owned HTTPS transport and clock to cover
stalled connections/bodies, transport and response errors, all-clear delivery,
ordered results and single completion without network access or real waits.
Their `NIGHTSCOUT_PLUGIN_TASK_ORACLE_ROOT` option checks an earlier implementation
against the same contracts. `tests/api.treatments.test.js`
uploads the same pre-bolus batch twice and verifies stable record counts and IDs
against a disposable MongoDB database.

Validation so far: 20 focused cases pass on Node 22.23.2 and 24.20.0; the real
treatment API suite passes all ten cases. The first full backend run had 1,627
passing, one pending and three socket-hang-up failures in API shape tests. An
instrumented full run then passed 1,631 cases with one pending, including the
new replay case. It did not reproduce the socket failures, so their cause is
not established. Client-core passes all 283 cases on Node 24. Hosted CI and
final merge verification remain required.

The lockfile removes one installed package path and changes no retained paths.
The removed package contains 91,385 regular-file bytes in the parent install.
All six production JavaScript bundles are byte-identical to the parent. These
are package/build measurements, not evidence of retained server-memory savings.
