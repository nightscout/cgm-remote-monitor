# Native review boundary — not executed

This candidate has no database/service grant. Root coordinates source review,
explicit runtime ownership and the coherent joined M5 acceptance. No live provider,
listener, cloud identity or external notifications are required by this plan.

The opt-in instrument is `tests/tenant-notifications.integration.test.js`, flag
`NS_TENANT_NOTIFICATIONS_TEST=1`, explicit disposable `NS_TEST_POSTGRES_ADMIN_URI`.
It uses the existing migration runner on a new UUID-derived namespace and creates
only a new NOSUPERUSER/NOBYPASSRLS outbox application role. It grants no clinical
or schema writes. Cleanup drops only its exact owned namespace/role after pools
and children close. The external native runner must provide a pinned local PG
image with no pull/build; capture container/volume baselines and Node birth IDs
before startup; verify exact image/owner/mounts and independent absence after.
Unknown resources are never cleaned up. This file authorizes no invocation.

Predicted ordinary **seven passing, zero pending/failing**:

1. Actual committed request/attempt is independently visible when the fake
   consumer enters. New handles retain accepted dedup; a new legitimate output
   rearms at the existing15minute boundary with a new request identity.
2. A real Node child reaches a fake acceptance with no completion callback after
   request+attempt COMMIT. Independently read attempting row, kill exact child,
   create a new component/output after the explicit persisted deadline/normal
   short window, and verify the same request identity is retried and accepted.
   This measures process death with synthetic acceptance, not provider delivery.
3. Abort after actual INSERT before COMMIT; independent admin cannot see it and
   no adapter enters. The restored path's failed callback persists uncertain,
   never accepted. No SQL/writer repair is invented if this fails.
4. Pending retry is blocked after a newly observed snooze and after the current
   condition disappears. The foreign tenant's stored requests remain unchanged.
   The gate here is a synthetic capability; the joined alarm lane must add its
   actual current restricted-PG suppression reader before whole M5 acceptance.
5. Actual RLS hides B from A; cross-tenant insert, clinical write and schema DDL
   return42501. Independent role inspection says non-superuser/non-bypass and B
   remains byte-for-byte unchanged.
6. Unsafe installed RLS, broad table UPDATE, schema CREATE or foreign clinical
   write grants must refuse before request insertion/adapter effects; restoring
   exact privileges recovers. Readiness also requires read-only matching migration
   ledger and rejects owner/elevated memberships.
7. Persisted selected-consumer receipt references survive handles; a clear without
   plugin/level reaches the adapter, and only explicitly acknowledged cancellation
   references are marked cleared. Actual provider cancellation remains unmeasured.

Each case emits `TENANT_NOTIFICATION_OBSERVATION` with synthetic physical state
before its final assertion. The bounded private runner must validate these raw
physical observations before classifying a report as expected green/red. Setup,
SQL permission surprises, timeout/TypeError and pending are invalid evidence.

Meaningful source-archive controls for the native grant:

- `premature-dispatch` from `tests/fixtures/tenant-notification-controls.json`,
  selected case1: fake consumer independently sees no committed request before a
  real request is later inserted. Red `NOTIFICATION_NATIVE_DURABLE_REQUEST`.
- `retry-identity`, case2: forget unresolved request during a new output/runtime
  admission after the short window, yielding a second row/new ID after child
  accepted the first. Red `NOTIFICATION_NATIVE_RETRY_IDENTITY`. Two synthetic
  effects already illustrate why actual provider idempotency remains separate.
- `failed-accepted`, case3: actual error callback incorrectly persists accepted.
  Red `NOTIFICATION_NATIVE_FAILED_SEND_NOT_ACCEPTED`.
- `suppression`, case4: ignore the current gate and invoke the fake consumer after
  snooze. Red `NOTIFICATION_NATIVE_SUPPRESSION_NO_DISPATCH`.
- `readiness`, case6: archive-only skip of the consumed readiness guard admits
  an actual request while operator-owned heads RLS is disabled. Independent stored
  rows/fake effect become visible. Red `NOTIFICATION_NATIVE_UNSAFE_NO_EFFECT`.
  Other ordinary case6 grant mutations remain expected fail-closed refusals; never
  count an unrelated SQL permission/setup error as the intended control.

A fresh ordinary7 restores after this family. Token/close/config/condition
controls already have source-protocol assertions; they are not relabelled native
proof. Choose the final focused sequence with root rather than rerun a full
campaign for every helper. A mismatch stops after exact cleanup; preserve failure,
report exact source/command/symptom, and await narrow disposition. No automatic
source/oracle rewrite or native retry into green.

Root owns actual lifecycle→alarm selection→notification composition, explicit
selected-consumer fanout, tier/corpus registration and one coherent full/browser/
enabled-corpus/final-prcheck campaign. That joined testing must cover consumer
impacts, actual current config/tenant and durable alarm read failures, accepted
and ambiguous outcomes, clear versus pending alarm retry, restart and shutdown.
Source-protocol fakes alone close none of those joined native claims.

Native preparation uses PG clock_timestamp for reset/start and updates child
configuration with that same epoch. Later deadline/rearm boundary instants are
explicit fixture inputs, not measured wall-clock wait guarantees. Native lifecycle
result envelopes carry tenant/requested/inputCheckpoint. The joined actual alarm
fixture must align evaluation/attempt instants with actual accepted ackAt/expiresAt
(or a common actual DB epoch); it must not compare1970 synthetic instants to a
current database ack. Root owns that actual lifecycle→alarm→outbox integration.

Root joined-native inputs must select `normalPolicy:'realtime-cycle'` for the RT
adapter and `normalPolicy:'pushnotify'` for the synthetic provider-compatible
comparison. Required SQL/component operations now carry the selected policy;
head/request keys and due scans isolate them. RT adapter acceptance is null receipt
and empty cleared IDs. Include same-output/event once, new-output same-alarm
repeat, old uncertain request not blocking later cycles, same-ID retry, policy
change/isolation and current suppression/close in actual RT consumer testing.
Independent outbox tests default explicitly to pushnotify; that is not proof that
provider cache windows are suitable for browser realtime.
