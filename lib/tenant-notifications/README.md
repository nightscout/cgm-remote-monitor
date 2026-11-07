# Durable tenant notification requests — explicit preview capability

This component is dormant until a trusted composition selects it. It changes no
single-tenant code, starts no listener or timer, selects no provider and performs
no network I/O. Its adapter is an explicitly supplied bounded capability. Source
protocol and synthetic callback tests do not establish actual provider delivery.

`component({store,adapter,selectCycle,isCurrent,allows,now,normalPolicy,maxRows,maxPayloadBytes,
maxInflight,attemptTimeoutMs,retryDelayMs})` consumes a successful eligible cycle
through `run(tenant)`. The cycle envelope is
`{tenant?,identity,runtimeId,outputRevision,inputCheckpoint,eligible,result:{emitted}}`.
Alarm filtering creates a fresh result envelope on each read. Stability uses the
trusted config/runtime/output/checkpoint tags and rechecked semantic eligibility,
never the filtered result object's identity.
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
accepted_at,receipt,cleared_at) on requests; and SELECT on its schema_migrations
ledger. Both data tables force tenant RLS and
revoke PUBLIC privileges. No schema/clinical/credential/operator write authority
is needed. Every store transaction consumes installed-schema readiness before its SQL effects:
non-elevated role/membership, non-owner schema/table, no schema/database CREATE or
foreign writes, forced RLS and exact tenant policy, column types/nullability/primary
keys, exact narrow updates and read-only matching migration ledger. Privileges are
not cached. `store.ready(tenant)` exposes the same consumed guard for role startup.
Database enforcement and actual process death remain native acceptance work;
source-protocol fakes are not RLS evidence.

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
Success reserves the normal key through the existing15minute expiry instant; a
later output can create a new request strictly after expiry. Failed attempts use the existing30second
minimum retry window, including the exact expiry instant, together with the
explicit operator retry delay. Calling retry within that window does not extend
it. A new actual attempt registers its dispatch marker in a separate consumed
COMMIT; restart cannot bypass an active marker merely because an attempt deadline
expired. One already-consumed output instance does not
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
references (one hour inclusive of exact expiry, matching the existing cache) for the same tenant. As in `pushnotify`, clear cancellation can address
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

Normal admission keys are not delivery-effect identity: actual simplealarms LOW
and HIGH share plugin+urgent level, and one LOW condition can have a new reading
message. Eligibility compares all serialized delivery fields, with canonical
object-key ordering and array/type preservation. Only the plugin implementation
graph, pushnotify's derived key and debug diagnostics are excluded. Runtime and
evaluation revision/timestamp metadata live outside the notification payload.
A materially changed pending effect is retired without overwriting its UUID or
payload; its current replacement can be admitted in the SAME run strictly after
the original normal window. Same meaningful payload with changed diagnostics or
runtime identity retries the same UUID. Head-before-request locking and attempt
tokens fence retired late callbacks from completing/updating a new head.

The source-composition regression requires the actual tenant-alarms selector. In
the coordinator's joined tree it loads the sibling module normally. Before that
join, the focused lane supplies an explicit NS_NOTIFICATION_ALARM_CYCLE test-only
path to an immutable archive of the actual alarm source, with source head/hashes
in the private capture. No stable-return fake substitutes for that regression.

Consumer normal admission is REQUIRED: `normalPolicy:'pushnotify'` preserves the
provider-side30second/15minute/1hour behavior measured above;
`normalPolicy:'realtime-cycle'` preserves actual AlarmSocket event delivery, which
has no provider rate-limit cache. Policy identity is immutable in the persistent
request/head signature and due reads are filtered by policy. Switching selected
policy cannot reuse or retry the other policy's work. Operator rollout closes the
old composition before replacing it; unselected uncertain history is not falsely
marked accepted or silently dispatched.

Realtime admits each trusted output-instance/event separately, even when another
cycle's request is uncertain. Re-running the same event does not create a second
request. Event occurrence derives from canonical meaningful payload plus its
same-effect occurrence, not filtered-array index: suppression of another event
cannot cause a duplicate. The persisted UUID remains retry identity across
uncertainty/restart; later eligible cycles may emit the same alarm again, matching
existing RT behavior. RT uses only explicit retry delay/attempt deadlines, never
provider30second or15minute windows. Current payload/config/suppression guards
still apply. RT clear is a normal clear event under current socket authority, with
`receipts:[]`; acceptance returns `receipt:null,clearedRequestIds:[]`. It has no
Pushover/device cancellation receipt. Callback acceptance is server handoff only,
not device delivery or external exactly-once. Existing single path is unchanged.
