# Process-owned participation sessions

The private operation window uses bounded process-owned PostgreSQL sessions to
register and finish tenant-generation participation. `leaseSessions` in
`MULTITENANT_OPERATION_CONFIG` keeps its existing positive bound within
`NS_POOL_OPERATION_MAX`; omission uses that pool's bound. Single-site Mongo
composition does not select this adapter.

A tenant maps to the first unsigned 32 bits of SHA-256 of its canonical UUID,
modulo the selected count. Sessions open lazily. Their short serial sections run
only on first tenant-generation registration, restore/shutdown completion and
control reads. Warm HTTP, internal API and socket bodies enter process-owned
accounting directly: they do not enter the session queue or create marker SQL.
Clinical transactions keep their own pool, shared lock, live authority and
generation checks. No advisory lock is retained merely because a process warmed
a tenant. See [the operation window](operation-window.md) for body and drain rules.

Cold admissions retain the configured connection-wait deadline; an expired job
never runs SQL later. Completion jobs take priority because durable markers must
finish before maintenance can proceed. Healthy control reads can reuse an owned
session even when sessions occupy every pool slot. No pool increase or new wait
budget is introduced. A hot tenant needs no lane job after its first registration.

Backend error/end is sticky and invalidates associated bodies once. The failed
client is released as failed, queued jobs refuse, and no request replaces its
owner. Recovery admits the exact datastore and waits for actual failed bodies to
drain before resetting failed sessions. Old unfinished markers stay unchanged.
An uncertain registration COMMIT does not start a body; uncertain completion does
not claim success. Marker RLS still binds PID and backend birth, so a replacement
session cannot finish its predecessor's record.

A healthy participation marker remains unfinished between requests. Restore first
suspends the tenant, then its pinned participant RPC closes admission and waits
for actual body/child completion before finishing the marker once. Graceful
shutdown does the same for all warmed tenants. An abrupt owner loss consequently
leaves coarse markers even for idle warmed tenants. Existing explicit clearance
handles them; reconnect and elapsed time are never completion evidence.

These sessions retain metadata-only authority and are not accepted as clinical
writers by role labels. Actual source/native controls must distinguish the
process accounting contract from the retired per-request row-count assertions.
Capacity and shutdown duration remain unmeasured until a coherent deployment run.
