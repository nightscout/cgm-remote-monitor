# Realtime completed-output consumer

The multitenant realtime role delivers the evaluator's typed completed output to
current authorized viewers. Select `realtime` through the multitenant CLI and
supply `MULTITENANT_REALTIME_CONFIG`. The ordinary single-tenant server uses its
existing socket composition.

`config.js` requires version 1 and these explicit fields:

- `postgres`: `connectionEnv` and `namespaces` containing `clock` and `checkpoint`.
- `consumer`: a `realtime-` name; `maxRows`, `maxBytes`, `maxTenants`,
  `maxMessageBytes` and `operationTimeoutMs` bound the selected capability.
- `registry`: the admitted tenant registry; `tenantSettings`, `activity` and
  `trustedWorker` identify the current presentation and control metadata.
- `completedOutput`: the evaluator checkpoint namespace and consumer.

`authorizationRecheckMs` and `unauthorizedDeadlineMs` are optional authority
bounds. Configuration references environment variables for connection values.
The boot file carries process configuration; live tenant membership and settings
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
result-free physical frame in one repeatable snapshot. Retained frames must match
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
replace browser state. Connected storage viewers receive the existing normalized
change events. The inherited storage subscribe packet carries no offline cursor
or reset contract. Alarm handoff preserves the durable notification and attempt;
acceptance means server handoff, not device delivery. Uncertain replies can repeat.
The existing main/alarm acknowledgment routes and current rights still apply.

Private operations use the selected internal service transport and bounded JSON
and deadlines. UDS paths retain owned-directory, inode and cleanup checks. Public
HTTP exposes health and sockets; private service paths remain absent. Shutdown
closes transports so clients reconnect with their normal backoff.

Focused source checks establish their recorded protocol contracts. Native SQL,
browser and whole-system results are recorded against the joined candidate.
