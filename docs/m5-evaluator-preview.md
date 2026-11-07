# Explicit evaluator preview lifecycle

Contributor-facing source and acceptance contract. Selected only by
`nightscout multitenant evaluator` with `MULTITENANT_EVALUATOR_CONFIG` naming a
trusted operator JSON file. No listener, provider delivery, human credential,
ack state, notification handoff or lease is selected. Existing single behavior
and unselected roles remain unchanged. Lifecycle native acceptance is UNMEASURED
until its separately reviewed frozen-source run; accepted bounded acquisition on
`57d54963b59a2bbd209ea7b8d9ce1ba9f1993a58` remains its immutable foundation.

## Configuration and readiness

`lib/server/serve/evaluator-config.js` requires the following complete schema.
No interval/capacity default or performance acceptance target is implied.

| Field | Required value |
|---|---|
| version | 1 |
| postgres | connectionEnv naming an environment variable; namespaces containing distinct non-system names for entries, treatments, devicestatus, profile, food, activity, clock and checkpoint |
| consumer | role-owned name beginning evaluator-, separate from realtime/other consumer checkpoints |
| pageSize, maxRows, maxBytes | positive safe integers, pageSize no larger than maxRows; projection acquisition/retention limits |
| maxTenants | explicit positive configured-tenant ceiling |
| recoveryIntervalMs, timeIntervalMs | explicit positive integer milliseconds within Node's supported timer range; descriptive schedule configuration, not measured freshness/capacity |
| tenants | unique canonical tenant IDs, bounded by maxTenants; each has string revision, safe settings and optional safe extendedSettings |

The regular config file is bounded to one MiB. Unknown/mistyped fields, unsafe
namespaces, missing credential reference and unsupported settings refuse.
Credentials remain in the environment. The reader needs SELECT on six clinical
tables, clock, owned checkpoints and their reviewed migration ledgers, plus only
UPDATE(checkpoint,projection,contract_digest) on checkpoints. No clinical/clock
write, schema creation, owner/operator authority or unrelated data read is
admitted. Readiness screens effective and assumable-role privileges, forced RLS,
provisioned per-tenant consumer/clock rows and reviewed current catalogues. Boot
runs check only; operators own migrations and provisioning.

Every cycle rereads the trusted operator file. Clinical context identity hashes
declared revision **and effective settings/plugin content**; reusing a revision
cannot preserve stale context. This is independent of the presentation-only
owner settings component. Tenant removal disables/discards that context. Tenant
expansion, database/schema/consumer/bound/schedule changes require restart.
An invalid config refuses and retires its context; no process environment or
legacy credentials are substituted.

## Owned jobs and time semantics

Role boot is independent of listener resolution, so evaluator-only starts work
without HTTP. Each configured tenant acquires at startup/restart and then on an
explicit recovery backstop; trusted in-process composition may request acquire.
Per-tenant jobs serialize and coalesce; different tenants can progress independently.
The current-state backstop is deliberately separate from the time-only schedule.
A time tick uses only the last successfully computed retained input and its
acquisition statistics, advances no input checkpoint and performs no current-table
acquisition. Projection reads still use the existing JSON-source SQL reader.

A changed config retires the old retained frame and creates a new component. A
time tick on that new component refuses until an independent acquisition succeeds;
it does not secretly reload rows. Generation fences prevent config disable/change
during async reads, creation or computation from restoring an obsolete eligible
result. Shutdown cancels schedules, fences in-flight publication, drains jobs and
closes the owned pool. Repeated close is idempotent.

Acquisition/bound/COMMIT failure retains the last good persisted input and clinical
result, marked ineligible. A successful time tick cannot heal failed acquisition
eligibility. Downstream clinical failure may keep a successfully committed newer
input projection while retaining prior clinical output; a later acquisition retries
even if the input floor is unchanged. No failed cycle produces a successful output.

## Trusted composition interface

`evaluator-preview.boot(config)` exposes acquire(tenant), tick(tenant), health(),
last(tenant), isCurrent(tenant,identity), close(). No external control endpoint is
created. last returns the latest successful result with:

- identity: effective trusted clinical config identity;
- runtimeId and outputRevision: process UUID and local successful-cycle ordinal;
- inputCheckpoint: input snapshot floor, not an output/delivery cursor;
- trigger: acquisition or time-only;
- result: actual clinical result; eligible: freshly computed lifecycle eligibility.

The returned object is a snapshot. Consumers must reread last for current cycle
eligibility and call isCurrent before acting; an old object with eligible=true is
not a continuing authorization. isCurrent rereads current operator config/allowlist,
refuses disabled/mismatched state and cannot retire a newer current context merely
because an older consumer asks. It is a config gate, not human/socket authority.
No durable request identity or notification completion is inferred from local
outputRevision or inputCheckpoint. Alarm and durable-request components are
composed separately under their own contracts.

## Focused proof boundary

Source tests cover listenerless selection, config content/revision/disable and
in-flight generation races, queue coalescing, A refusal/B progress, retained-time
separation, unchanged-input retry, current eligibility and close fencing. Native
fixtures prepare actual role/CLI processes with restricted PG, canonical commits,
independent physical rows/checkpoints and raw observations before verdict:
startup/restart, quiet absence/activity backstop, time-only isolation, config
rebuild, row/byte refusal and tenant progress, real held-read shutdown, and actual
unsafe clinical/clock/checkpoint/unrelated grants refused before work.

Archive-only product controls restore the listener-only boot loop, disable recovery
backstop, make time evaluation acquire, ignore config identity and bypass shutdown
publication fences; generation fencing has its own source-protocol control. Each
must fail at the intended semantic state, never setup SQL/TypeError/watchdog/pending,
then restore on fresh ordinary source. Historical57 reconciliation controls and
R67 clinical/typed evidence are not relabelled or repeated here.

COUNT/SUM still scans admitted source; cadence, contention, memory/capacity and
freshness budgets remain unmeasured. This preview does not prove a feed provider,
retained every-transition history, notification delivery, failover/leases,
production activation or M5 completion. Comprehensive verification belongs to the
later coherent joined M5 candidate, not each helper.
