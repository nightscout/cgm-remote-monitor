# Durable tenant notification requests — explicit preview capability

This component is dormant until a trusted composition selects it. It changes no
single-tenant code, starts no listener or timer, selects no provider and performs
no network I/O. Its adapter is an explicitly supplied bounded capability. Source
protocol and synthetic callback tests do not establish actual provider delivery.

`component({store,adapter,selectCycle,isCurrent,allows,now,maxRows,maxPayloadBytes,
maxInflight,attemptTimeoutMs,retryDelayMs})` consumes a successful eligible cycle
through `run(tenant)`. The cycle envelope is
`{tenant?,identity,runtimeId,outputRevision,eligible,result:{emitted}}`.
`selectCycle` must obtain the current successful output, not cache an earlier
`eligible:true` value. Failed acquisition/evaluation/config reads make that output
ineligible even when a prior successful display result is retained.
`isCurrent(tenant,identity)` re-reads current configuration and tenant admission;
`allows({tenant,notification,at})` performs a fresh bounded suppression read.
Neither has a permissive fallback. Current emitted alarm condition, current
configuration and suppression are checked before admission and again immediately
before every dispatch/retry. A now-cleared or snoozed alarm is not retried.

The store uses a separate operator-created namespace from clinical storage.
`postgres-candidate.json` is an isolated append-only migration catalogue, not an
edit to any installed migration. The application role requires USAGE on this
namespace; SELECT/INSERT and UPDATE(request_id,blocked_until) on heads; and
SELECT/INSERT and UPDATE(state,next_at,attempt,attempt_token,attempt_until,
accepted_at,receipt,cleared_at) on requests. Both tables force tenant RLS and
revoke PUBLIC privileges. No schema/clinical/credential/operator write authority
is needed. Database permissions and actual process death are native acceptance
work; source-protocol fakes are not RLS evidence.

Request admission and attempt registration each require a **new transaction**
using the existing PostgreSQL connection's verified COMMIT boundary. They cannot
be nested in an open clinical transaction. The request is committed before an
adapter can run. This is not one atomic clinical-input/evaluated-output/outbox
revision: the input projection already committed and clinical computation already
succeeded. No every-transition notification guarantee is inferred.

A normal dedup head is scoped by tenant, selected consumer and effective config
identity. Its event key matches `pushnotify`: explicit notifyhash; otherwise alarm
plugin name + level; announcement/informational title/message hash. The normal
key intentionally follows existing group behavior. Pending/uncertain attempts
reuse their persisted UUID across component/process restarts and new output
instances. Runtime/output revision and input checkpoint are **not** retry IDs.
Success reserves the normal key for the existing15minute window; a later output
can create a new request at expiry. Failed attempts use the existing30second
minimum retry window, together with the explicit operator retry delay. Calling
retry does not extend that window. One already-consumed output instance does not
create a new request merely because its old window elapsed.

`retry(tenant)` reads a bounded page of durable pending/uncertain work and expired
attempt deadlines. Each attempt has a new token. A completion updates only its
current token; expired, superseded and closed callbacks cannot publish acceptance.
A timeout/ambiguous failure leaves uncertain work eligible for the same-ID retry.
A process that stops with attempting work leaves the durable deadline for the
next process. This is **at-least-once attempts**, with possible duplicate external
effects if a provider accepted a request and its response was lost. Adapter
acceptance is not delivery to a device. No external exactly-once effect is claimed.

Clear events are handled before normal alarm validation/dedup and may omit plugin
and level. They carry the selected consumer's bounded persisted active receipt
references for the same tenant. As in `pushnotify`, clear cancellation can address
all that consumer's retained receipts across groups. The adapter returns only
explicitly confirmed `clearedRequestIds`; no unknown/foreign consumer receipt is
released. Maker-style all-clear and Pushover-style cancellation remain explicit
adapter effects. No live provider is wired by these tests.

`adapter.id` is one selected logical consumer route. `adapter.send({tenant,id,
attempt,notification,receipts,signal},callback)` returns
`callback(error,{accepted:true,receipt?,clearedRequestIds?})` only when that selected
route accepts the effect. No automatic fanout occurs. A composition selecting
multiple consumers must explicitly instantiate their capabilities and verify
shared normal-admission versus per-consumer retry behavior in joined tests; one
consumer's success must not fabricate another's acceptance. The immutable stored
payload retains serializable event fields and only the plugin's name, excluding
the implementation graph. Changing consumer configuration changes config identity.

`close()` fences new jobs, aborts owned outstanding adapter waits and drains owned
jobs. An adapter may ignore cancellation externally, so closed/late callbacks are
ignored and attempting work remains recoverable after its deadline. External
hook/database work is the supplied capability's responsibility; this component
cannot cancel an arbitrary unresolved caller promise or driver query.

Bounds are explicit admission/page/payload/inflight/attempt-wait limits, not SQL
execution, wall-clock delivery, total retention or capacity guarantees. Queue
retention, cadence, backlog and latency budgets remain unmeasured operational
work. No production/default role enablement or M5 completion follows.
