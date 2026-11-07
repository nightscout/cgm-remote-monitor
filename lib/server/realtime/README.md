# Explicit same-host realtime preview

This opt-in role consumes the current typed clinical projection. It has no Vault
client, root-secret decrypt/sign ability, clinical write grants, or provider.
The default/single path is unchanged. Select `realtime` explicitly through the
multitenant CLI and supply `MULTITENANT_REALTIME_CONFIG` as an operator JSON file.
There are no cadence, capacity, tenant, credential, or database defaults.

`config.js` validates version 1 and the explicit fields `postgres` (connectionEnv,
namespaces for all six clinical domains, clock, checkpoint), `consumer` (a
`realtime-` name), pageSize, maxRows, maxBytes, maxTenants, recoveryIntervalMs,
tenants (same settings/revision shape as evaluator), admissionFileEnv,
apiSocketPathEnv, alarmSocketPathEnv, maxMessageBytes, operationTimeoutMs,
and maxSockets. Environment references contain the actual connection and paths;
configuration files must not contain credentials. Provision a distinct checkpoint
schema/consumer and its rows before boot. Its restricted role requires clinical
and write-clock SELECT and own-checkpoint bookkeeping only. Startup checks
installed catalogues, forced RLS, grants, and checkpoint scope. Configured tenants
must all be ready on startup; later individual failures stop their delivery and
report unhealthy while other tenants continue their scheduled recovery.

The shared admission file has `{version:1,mode:"preview-socket-allowlist",tenants}`
with rows `{id,enabled,aliases}`. Both processes reread it. It gates every socket
credential family and delivery, independently of token-family active flags.
This is preview socket admission, not the D15 public REST suspension lifecycle.
Tenant expansion and infrastructure changes require restart. Tenant config and
permissions are checked again after asynchronous acquisition and on each fanout.

The API config's optional `socketForwarding` has socketPathEnv, admissionFileEnv,
maxTenants, maxMessageBytes, operationTimeoutMs and alarm {connectionEnv,namespace}.
It requires explicitly selected legacy authorization and the write clock. Its
narrow alarm writer uses a distinct decoded user on the same hostname/port/database
endpoint as DATA/readiness (passwords are not datastore identity). Boot checks
the installed alarm catalogue through both readiness and the selected writer.
The writer needs SELECT on its alarm schema_migrations ledger; this adds no
ledger mutation permission. The narrow alarm writer must also SELECT authorization config/subjects/links/roles
for transaction-bound current admission. Apply the append-only alarm catalogue
and existing devicestatus/treatments socket-order successors before API startup.
The API independently resolves original Host and verifies original client
credentials. Its private endpoint never turns a workload connection into client
permissions. It reuses canonical socket handlers and the durable ack receiver.

Private HTTP over filesystem UDS accepts fixed authorize/mutate/alarm operations
only, with bounded JSON and absolute deadlines. Each endpoint owns a dedicated
restrictive real directory and refuses every pre-existing socket/path. Parent and
socket ownership/modes are checked. Linux binds an unadvertised unique internal
UDS and atomically hard-links it to the configured endpoint: Node auto-unlinks
its internal name while inode-guarded cleanup preserves a replaced public path.
Both paths must fit the explicit transport pathname bounds. This is the measured
one-machine Linux reference; malicious same-service-UID processes are outside
its process identity contract. This is same-service-UID trust, not process
identity or a deployment-wide bearer. Place endpoints outside public HTTP and
operator DATA surfaces. Cleanup is limited to the owned socket; no stale unlink.

Main connections receive full `dataUpdate` frames (`delta:false`) so absent SGVs
replace browser state. Reconciliation runs on boot, reconnect and the explicit
independent backstop; connected `/storage` subscribers receive normalized typed
identity changes in tenant/namespace/collection rooms. The inherited /storage subscribe packet contains no known IDs/cursor/reset;
arbitrary offline client-cache deletion is not a promised socket recovery
contract. Actual single subscribe has the same limitation. No new reset or
journal is invented here. Role projection recovery and connected diffs remain
required. Pinned client reconnect REST behavior is characterized separately.
ObjectId/string twins have separate internal identities but the inherited
normalized delete wire identifier can coincide; client behavior needs native
characterization. Profile first/retry natural-order parity also remains
unmeasured; no sorted substitute is selected and all-six-write parity is not
claimed.

Both main and /alarm ack forward under D23. The pinned AAPS request pattern uses
main ack, whereas the single reference persists ack only on /alarm. Test DATA
reply/storage retry parity separately; do not claim a single main-ack baseline.

`alarm-transport.createAdapter` implements
`send({tenant,id,attempt,notification,receipts,signal}, callback)`. The durable ID
and serialized notification pass unchanged. The sink rechecks current socket
rights and emits the existing event. Acceptance means server handoff,
not device delivery; uncertain replies can repeat. The callback returns `{accepted:true,receipt:null,clearedRequestIds:[]}`;
there is no provider receipt cancellation API. Clear broadcasts the unchanged
event under current rights. The root's joined outbox
composition must preserve realtime repeat cadence rather than applying push
provider repeat windows. No native socket, database, browser or provider result
is implied by source protocol tests.
