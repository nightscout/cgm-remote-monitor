# Selected evaluator durable realtime consumer

Source capability; native acceptance is UNMEASURED. The coordinator owns joined
acceptance. This route is optional and defaults off. Existing REST and single
notification initialization continue using the default service and clock.

## Consumed path

`evaluator-preview.boot` prepares dedicated outbox and suppression-reader
connections, proves the actual selected connections reach the clinical database
with a transaction-local nonce/lock challenge, and checks installed catalogues,
forced RLS, table shape and exact narrow privileges. Clinical acquisition and
retained-time scheduling do not await delivery. Per-tenant consumer jobs coalesce
independently and owned schedules stop on close.

Successful clinical `requested` notifications and plugin snoozes are processed by
the shipping notifications service with bounded private state. State and immutable
outbox intents commit together before the selected realtime adapter is called.
Clinical output-instance origin and clinical checkpoint remain separate from the
persisted logical request UUID. The realtime policy admits each successful output
once and permits subsequent cycle events, including a same-condition alarm.
Uncertain unchanged-payload attempts retry the same UUID. A current changed
payload/condition, clear, configuration or snooze retires obsolete pending effects.
Clear origin comes from a durable producer revision and stays outside browser
payloads; a newer alarm fences an old clear. No adapter completion writes producer
state or retires a newer transition.

An authorized committed ACK is a control event. It can derive the legacy ACK clear
from retained private state even after evaluator restart when initial clinical
acquisition fails. This does not evaluate plugins, infer normal clinical state or
emit an alarm from failed acquisition. Fresh configuration/tenant admission is
required independently of the last clinical result. Producer clinical identity is
kept separately from current control identity. A successful replacement clinical
configuration retires the old service through its actual normal processing before
creating new private state.

Selected API ACK admission links to the **same evaluator configuration file** via
optional `socketForwarding.consumerState.evaluatorConfigEnv`. It derives the
consumer key, outbox namespace and bounds; it does not open a worker connection.
The existing ACK connection receives SELECT only on producer state and its ledger.
The same transaction advisory fence precedes STATE and HEAD/REQUEST or suppression
locks in both processes. After that fence the ACK clock and original credential
permission are checked again. An ACK during an active plugin snooze is ignored,
preserving its original expiry; plugins never write owner suppression rows.

The suppression reader is intentionally active-only. An ACK never consumed before
its original expiry does not cause a historical clear replay after an outage.
Current successful normal state can still derive the shipping auto-clear. This is
bounded current-state recovery, without an every-transition or indefinite ACK
history promise. An already-issued uncertain external effect can still occur;
realtime acceptance means server handoff, not a device receipt or exactly-once
external delivery. A temporary missing realtime socket leaves retryable durable
state and degraded handoff health. Clinical health, persisted intent and observed
handoff acceptance have separate health fields.

## Explicit configuration and roles

Optional evaluator `consumers.realtime` requires:

- `outbox` and `suppression`: `connectionEnv`, `namespace`, `maxRows`, `maxBytes`,
  `maxConnections`;
- `route`: `id`, `socketPathEnv`, `maxMessageBytes`, `operationTimeoutMs`;
- `maxPayloadBytes`, `maxInflight`, `attemptTimeoutMs`, `retryDelayMs`,
  `pollIntervalMs`, `retryIntervalMs`.

All bounds are explicit positive safe integers; timer values fit Node timers.
Unknown options refuse. Namespace collisions and datastore mismatch refuse;
different restricted credentials for the same datastore are expected. Changes to
infrastructure or credentials require restart. Optional reviewed
`socketOrderDomains` is an exact unique subset of treatments/devicestatus/profile;
omission keeps the base reader catalogue, with successor readiness owned by the
realtime integration lane. These bounds are not a measured capacity or retention
budget.

The outbox worker has SELECT/INSERT plus exact mutable-column UPDATE on requests,
heads and state, and SELECT on its migration ledger. The suppression reader has
SELECT only on suppression and its ledger. Neither gains clinical/checkpoint
writes, schema creation or ownership. The selected ACK writer retains its existing
suppression mutation authority and gains only producer-state/ledger SELECT.
Migration `0001_tenant_notification_outbox` stays unchanged. Append-only `0002`
refuses any populated old heads/requests before creating producer state: no silent
assumption that old browser alarm provenance is empty. A populated upgrade needs a
separately reviewed recovery procedure.

## Prepared joined native campaign

Exact file: `tests/evaluator-consumers.integration.test.js`. Enable only under the
coordinator's frozen-source grant with `NS_EVALUATOR_CONSUMERS_TEST=1` and a disposable
`NS_TEST_POSTGRES_ADMIN_URI`. Five dormant cases use the actual selected evaluator
role/process, dedicated PostgreSQL principals, actual alarm writer/reader and the
actual protected UDS adapter. The sink is controlled synthetic code; the ACK
transport uses a synthetic trusted actor. These are not browser/credential
acceptance, covered by the separate actual realtime campaign.

Cases prepare: committed intent before sink; same-output/new-cycle realtime
admission; normal clear after process restart; lost acceptance response followed by
actual process death/restart with same UUID; ACK-only clear after cold acquisition
failure and changed current config; A/B independence; SELECT-only ACK state and
unsafe forced-RLS refusal; graceful owned exits. Independent admin rows and sink
observations precede assertions. Marker `M5_CONSUMER_OBSERVATION` carries phases
`sink-before-accept`, `committed-per-cycle`, `restart-normal-clear`,
`uncertain-process-restart`, `control-ack-with-failed-clinical`, and
`ack-state-readonly-and-rls-refusal`; child exits use `M5_CONSUMER_CHILD_EXIT`.
Physical observations for committed intent, unchanged wake revisions, restart clears/retries, control-only clears, SQL refusal codes and unsafe-state health are emitted before their semantic assertions. Additional phase names end in `before-verdict` (plus `uncertain-before-death`); final summaries remain separate. All clocks come from actual database/current epoch, never a 1970 fixture clock.

Native controls must target these actual boundaries: uncommitted/missing intent at
sink; regenerated retry UUID; state/head/request tenant scope or forced-RLS removal;
current suppression/config/condition bypass; lost clear state on restart; pending
old clear after a newer alarm; active plugin snooze extended by owner ACK; and
SELECT-only state privilege broadening. A permission failure in setup is not a
semantic red control. Native execution, process-death acceptance, actual Socket.IO
consumer compatibility, performance and comprehensive joined acceptance remain
UNMEASURED until captured on the coordinator's frozen joined source.
