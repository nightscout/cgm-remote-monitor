# D6 metadata feed and bounded recovery

Contributor-facing implementation contract. Opt-in multitenant metadata signalling;
existing inputs retain stage-1 detection without `changeFeed`. Capacity and outage
latency remain UNMEASURED until the joined candidate is exercised at scale.

Run the dedicated process with `nightscout multitenant feed-reader`. It cannot be
composed with serving roles or join a tenant operation cohort. `MULTITENANT_FEED_CONFIG`
names a bounded JSON file with these fields:

```json
{"connectionEnv":"FEED_PG","namespace":"cohort_feed","clockNamespace":"cohort_clock","activityNamespace":"cohort_lifecycle","slot":"cohort_feed_slot","publication":"cohort_feed_publication","channel":"cohort_changes","owner":"cohort_feed_owner"}
```

The connection is an EXECUTE-only NOSUPERUSER/NOBYPASSRLS/NOREPLICATION reader login,
with no membership in its NOLOGIN/NOSUPERUSER/NOBYPASSRLS/REPLICATION wrapper owner.
Bootstrap applies `lib/change-feed/postgres-candidate.json` in its own operational
namespace, then executes the explicit statements from
`require('../lib/change-feed/postgres').provision({namespace,clockNamespace,activityNamespace,slot,publication,owner,reader})`.
Publication and slot creation are fresh-deployment operations: callers must not
ignore duplicate/mismatched publication or slot errors. Serving identities receive
neither wrapper EXECUTE nor replication privileges. The helper sets the reader's
`temp_file_limit=64MB` and `logical_decoding_work_mem=64kB` role defaults.

PostgreSQL must use `wal_level=logical`, sufficient slot capacity and a finite
`max_slot_wal_keep_size` between 1 and 1024 MB. The reader checks those resource
settings, its login authority, wrapper exact body/security/owner/config/grants,
publication exact table set/filter/DML shape and slot database/plugin/WAL status.
The default publication contains clock and activity metadata. Optionally select
`settingsNamespace` and `policyNamespace` together in reader config and
`provision()`: these add exact column lists `tenant_settings(tenant_id,version)`
and `tenant_operator_policy(tenant_id,generation)`. Their wrapper owner receives
column SELECT only; readiness rejects plaintext-column grants, changed projections
or row filters. Settings/policy values and clinical/secret/audit bodies never enter
the publication. Configuration hints prompt current authoritative settings reads
without advancing or reusing the clinical write clock. Relation columns/types are checked before a hint is emitted. Changes to
those catalogues require explicit source/provisioning updates.

Reader defaults: `pollMs=50`, `heartbeatMs=1000`, `targetChanges=128`,
`maxMessages=10000`, `maxBytes=1048576`, `statementTimeoutMs=2000`,
`rssRefuseBytes=268435456`. Configuration validates finite ranges; no implicit
setting permits unbounded row/byte budgets. Polling peeks complete transactions,
coalesces tenant hints, commits notifications, then advances the slot through the
last complete commit. A lost reply may duplicate hints, never synthesize a clinical
result. A fixed-slot session advisory lock excludes another reader process.

**Resource limits have distinct meanings.** PostgreSQL decoding's change target
is transaction-granular. Wrapper row/byte limits run **after native decoding**;
`work_mem`/`logical_decoding_work_mem`/`temp_file_limit` constrain particular buffers
or spill files, not total server RSS. Statement timeout bounds the server query;
RSS refusal is a soft pre-query reader check. A reader cgroup protects that reader,
not the shared PostgreSQL server. Deployment must budget the shared database and
use appropriate process/cgroup limits. No hard total-RSS guarantee is claimed.
An oversized transaction is refused without slot acknowledgement, raises a reader
alert and leaves consumers on paged recovery. It may keep the reader degraded until
an explicit operator recovery; there is no silent skip, slot reset or WAL-loss waiver.

Evaluator and realtime accept optional configuration below, with their existing
`activity` reader configuration required whenever `changeFeed` is selected:

```json
{"changeFeed":{"connectionEnv":"ROLE_PG","channel":"cohort_changes","pageSize":64,"degradedPages":4,"intervalMs":1000,"heartbeatTimeoutMs":5000}}
```

The listener may use the existing serving identity. NOTIFY is untrusted metadata;
it grants no read or write authority. LISTEN commits before reconciliation. Each
hint schedules the named tenant only. Current tenant-bound stamps, activity and
configuration remain authoritative. Healthy operation still visits one fixed-size
page each interval to recover lost notifications; degraded operation visits the
configured additional fixed number of pages. Full-sweep latency grows with roster
size, is visible in recovery health, and has no unmeasured constant bound.

Data detection and cold/retry work have separate bounded queues. Evaluator time
alarms retain their existing timers, and evaluation-gap alerts keep a separate
per-tenant due-time watchdog. Choose a normal page sweep budget consistent with
that watchdog: at 1-second intervals, 64 tenants/page sweeps 3,000 tenants in
47 intervals but 10,000 in 157; 256/page sweeps 10,000 in 40. These are derived
scheduling bounds, not measured end-to-end latencies; callbacks, refusals and load
can increase them. Do not weaken the clinical alert deadline to hide slow recovery. Activity changes independently wake control
checks: pause/suspend disconnect sockets and stop evaluation; resumption reacquires
current data. Pause continues to admit uploads; suspend refuses uploads under the
existing serving policy. Listener restart, reader restart or lost heartbeat enters
degraded recovery; a new reader generation requires reconciliation. Notifications
are coalesced by known tenant, so unknown tenant/flood input cannot create an
unbounded per-message queue.

Focused tests: `tests/change-feed.test.js` and, with `NS_D6_FEED_TEST=1`,
`tests/change-feed.integration.test.js`. Native tests create and remove one owned
PostgreSQL container on a random loopback port. They exercise normal SQL RLS,
EXECUTE-only authority, complete-transaction handling, notification/ACK loss,
listener reconnect, reader outage, activity changes without data writes, other-tenant
progress, metadata tamper refusals and post-decode oversize refusal. The native
schema is synthetic: this is not full clinical/restore/deployment acceptance.

Registry consumers can start empty and admit later provisioned tenants. Admission
prepares settings, checkpoints and owned startup resources before registry-visible
activation; failed preparation retries independently of registry revision. Removal
hides the tenant before timer/queue cancellation and asynchronous component drain.
The consumer's explicit add/remove roster methods update its paging cursor and
coalesced dirty queue; hints and retries do not reconstruct the full roster.
Focused live-admission controls are in `tests/tenant-live-add.test.js` and
`NS_TENANT_LIVE_ADD_TEST=1` `tests/tenant-live-add.integration.test.js` (owned
PostgreSQL and Vault). Native clinical alarm computation and frame computation are
covered; external alarm delivery, deployment acceptance and capacity remain the
joined candidate's acceptance boundary.
