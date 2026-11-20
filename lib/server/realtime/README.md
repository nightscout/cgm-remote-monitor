# Realtime completed-output consumer

The multitenant realtime role delivers the evaluator's typed completed output to
current authorized viewers. Select `realtime` through the multitenant CLI; its
configuration comes from the role settings (`docs/multitenant-settings.md`). The ordinary single-tenant server uses its
existing socket composition.

`config.js` validates the value the settings build, version 1 with these fields:

- `postgres`: `connectionEnv` and `namespaces` containing `clock` and `checkpoint`.
- `consumer`: a `realtime-` name; `maxRows`, `maxBytes`, `maxTenants`,
  `maxMessageBytes` and `operationTimeoutMs` bound the selected capability.
- `registry`: the admitted tenant registry; `tenantSettings`, `activity` and
  `trustedWorker` identify the current presentation and control metadata.
- `completedOutput`: the evaluator checkpoint namespace and consumer.

`authorizationRecheckMs` and `unauthorizedDeadlineMs` are optional authority
bounds. Configuration references environment variables for connection values.
The settings carry process configuration; live tenant membership and settings
come from the registry and committed presentation records. Static tenant lists,
admission files, raw clinical namespace lists, `changeFeed`, `socketOrderDomains`,
`pageSize`, `recoveryIntervalMs` and `settingsRefreshMs` are refused. A file that
sets `maxSockets` receives `REALTIME_CONFIG_MAX_SOCKETS_REMOVED`; deployment edge
policies own connection flood limits.

Provision the realtime typed checkpoint catalogue and consumer rows before boot.
`pgstream/realtime-receipt.contractDigest(namespace, consumer)` supplies the
immutable provisioning tag. The runtime's mutable delivery authority is the
versioned receipt, exact producer revision and current worker owner. Its role
reads the evaluator's completed source and selected control/presentation metadata,
and updates only its five typed receipt columns. Readiness checks forced row
security, installed catalogues and the selected grants.

A producer commits durable output/control work before attempting its independent
realtime handoff. Realtime commits an idempotent receipt before answering the
private handoff. Its bounded drain checks addressed tenants, invalidates ineligible
sockets, acquires changed completed revisions and acknowledges successful work.
Failed tenants retain durable retries; other tenants continue. Startup and worker
recovery claim pending receipts. The earliest actual retry owns the next timer.
Warm tenants have no discovery timer or periodic roster scan. Known cold tenants
have bounded preparation/retry work. Registry membership and fixed worker health
checks retain their own responsibilities.

Each addressed output/control check reads current joined metadata and committed
configuration. Delivery reads the compact typed envelope and, when needed, the
result-free and row-free physical frame in one repeatable snapshot. Retained frames must match
current identity, digest, revision, restore generation, envelope and local frame
fingerprint. A changed or mutated hint causes a physical fetch. Clinical evaluator
results remain with evaluation. Row and byte bounds apply before decoding.

The API resolves the original host and authorizes original client credentials.
Concurrent connects share preparation and authorization by tenant and credential;
uncertain API replies or pool pressure retry without inventing authorization.
The protocol rechecks credential expiry and revocation, and honors pause,
suspension, admission removal and lifecycle invalidation, including idle sockets.
Ownership and restore-generation fences also cover asynchronous publication.
Compatible authorized viewers share Socket.IO packet encoding per publication.
Slow viewers with bounded output queues are disconnected.

Main clients receive full `dataUpdate` frames (`delta:false`), so absent SGVs
replace browser state. Connected storage viewers receive normalized `create`, `update` and `delete`
events from the bounded raw mutation tail in the evaluator input checkpoint's
second JSONB envelope. Clinical rows occupy the first envelope; expiry, clinical
refusal and output replacement cannot fabricate source mutations. Accepted raw
changes and their existing delivery-revision obligation commit before stream ACK.

Realtime is the sole owner of completed-output delivery progress for both
channels. The evaluator commits `delivery_revision` with its output (and with
each raw-tail append) and then sends only a disposable, coalesced wake naming up
to 64 tenants (`completed-output` contract v3); it writes no delivery ACK and
keeps no delivery retry. The configured database trigger copies the revision
to each subscribed consumer's `output_target` in that same transaction. A new
subscription starts at the producer's current revision. Realtime reads its own
receipt in one read-only statement per page, delivers through the addressed check, and
records completion, or one retry due time, for the whole page in one UPDATE
under owner and monotone-revision fences. Wakes coalesce for `flushMs`, so the
raw-tail and output revisions of one cycle share a delivery. A bounded paged
reconciliation runs at startup and every 30 s. Its index contains a tenant key
for each receipt whose target exceeds its completion. One consumer can settle its
receipt while another still owes the same revision. The DBA installs the binding
and backfills existing receipts under the same locks before serving.

Each storage subscription starts at its current source-tail high-water mark and
receives later events in source order. Exact retries do not repeat an event within
a retained session cursor. Distinct equal-LSN COPY rows remain distinct. The
inherited subscribe packet carries no offline cursor, initial population or reset
contract; reconnect starts another live subscription. No offline catch-up or
external exactly-once guarantee is introduced. A live cursor older than the
bounded tail is disconnected with `REALTIME_STORAGE_CONTINUITY_LOST`. It never
silently skips to the latest state. Temporary authorization uncertainty retains
the cursor until recheck; revoked collections receive no further events. Restore,
ownership and current-worker fences apply before raw publication as for frames.

Migration `0100_<domain>_storage_identity` selects `REPLICA IDENTITY FULL` for each
clinical source table. The old document supplies the actual public identifier for
delete/rename, including a public identifier different from typed `_id`. Omitted
unchanged TOAST documents on metadata-only updates produce no raw client event.
Readiness refuses the old identity mode. This adds WAL bytes for old documents;
it does not change source retention, REST, export, whole-history statistics or
logical table inventory. The raw tail has its own bound (1,000 events, 512 KiB,
`storage-event-journal.js` `BOUNDS`), sized for a live cursor's catch-up across a
recheck, not the evaluator's clinical-input limits; completed-frame consumers retain their own bounds. Alarm handoff preserves the durable notification and attempt;
acceptance means server handoff, not device delivery. Uncertain replies can repeat.
The existing main/alarm acknowledgment routes and current rights still apply.

Private operations use the selected internal service transport and bounded JSON
and deadlines. UDS paths retain owned-directory, inode and cleanup checks. Public
HTTP exposes health and sockets; private service paths remain absent. Shutdown
closes transports so clients reconnect with their normal backoff.

Focused source checks establish their recorded protocol contracts. Native SQL,
browser and whole-system results are recorded against the joined candidate.
