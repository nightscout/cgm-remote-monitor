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

Provision the realtime checkpoint catalogue and consumer rows before boot.
`pgstream/realtime-output.contractDigest(namespace, consumer)` supplies the
immutable provisioning tag. Realtime is a reader (decision D23): its role reads
the evaluator's completed source and selected control/presentation metadata and
holds no UPDATE right on any table. Readiness checks forced row security,
installed catalogues and that the role can write nothing.

Delivery is level-triggered (`runtime.js`). Per tenant the process holds one
cell: the frame it last read, the settings identity it was read under and the
one read in flight. A watched tenant whose durable `output_revision` is above
its cell's is read again. Two triggers reach that one check: the evaluator's
disposable wake hint, and a level pass every 5 s over the watched tenants (one
batched control read and one batched checkpoint read). A tenant nobody watches
is never read. A read is single-flight with a deadline, at most two at a time;
no step waits on a tenant, so a slow tenant delays only itself. An error
withholds the frame and a later pass converges to the latest revision; only a
completed read that refuses the tenant drops its frame and its sockets.

Per socket the protocol (`protocol.js`) holds its rights, when they were last
confirmed and the frame it was last sent. A socket is sent its tenant's frame
whenever it is behind it, may read, and its authorization was confirmed within
the validity bound (1.5 recheck intervals) and is not past the credential's
expiry. An inconclusive recheck immediately withholds frames on that socket
until a fresh check succeeds. A completed refusal disconnects it. One fixed-rate
sweep renews authorizations. A handshake reads nothing
about the tenant's output and is accepted for a tenant without a frame. One
configuration read serves a fanout. A prime or recheck batch shares a
configuration read and an api call per distinct credential, namespace and Host.
Each socket's admission uses its own request and peer.

The slice's owner session is held on a dedicated connection and checked by a
liveness statement on it. A check that times out is uncertainty. On loss of
the session delivery is withheld, transports close, and the lock is taken
again with backoff; the role ends only for a differing layout or when the
slice cannot be held again within two minutes.

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

Main clients receive the evaluator's frame as a single-site delta
(`lib/data/calcdelta.js`) against the frame that socket last received (decision
no-realtime-fast-path). A new or re-authorized socket, a lost or out-of-order
base, a settings identity change, and a change a delta cannot express (a removed
SGV or device status) get the full frame (`delta:false`), so absent SGVs
replace browser state. Connected storage viewers receive `create`, `update` and
`delete` events for the APIv3 writes that fire them on a single site (decision
storage-events-single-tenant-parity): the api sends them after commit as a
best-effort `storage-events` hint (`storage-hint.js`). A lost hint is not
retried; a client re-syncs over REST as after any socket drop. Restore,
ownership and current-worker fences apply before publication as for frames.

The evaluator commits its output revision and then sends only a disposable,
coalesced wake naming up to 64 tenants (`completed-output` contract v3); it
writes no delivery ACK and keeps no delivery retry. Realtime records nothing
about delivery in the database: migration `0004_realtime_receipt_removed`
removes the earlier receipt columns, owed index and obligation triggers. Wakes
coalesce for `flushMs`; a lost wake is covered by the level pass. The private
inspection (version 6) reports how many tenants entered and are in each read
stage (fetch, prepare, send) and each tenant's last stage. Alarm handoff preserves the
durable notification and attempt; acceptance means server handoff, not device
delivery. Uncertain replies can repeat. The existing main/alarm acknowledgment
routes and current rights still apply.

Private operations use the selected internal service transport and bounded JSON
and deadlines. UDS paths retain owned-directory, inode and cleanup checks. Public
HTTP exposes health and sockets; private service paths remain absent. Shutdown
closes transports so clients reconnect with their normal backoff.

Focused source checks establish their recorded protocol contracts. Native SQL,
browser and whole-system results are recorded against the joined candidate.
