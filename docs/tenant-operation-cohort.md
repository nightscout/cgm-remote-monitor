# Tenant-local restore operation cohort

The explicit multitenant preview can select `MULTITENANT_OPERATION_CONFIG`
through its private service environment. The configuration names a provisioned
operation-control schema, a database environment reference, and each tenant's
unique positive advisory-lock key. The fixed manifest covers API, evaluator, realtime and
tenant-admin across separately launched processes; API replicas can be declared
as separate participants. The earlier v1 co-located form remains available for
component tests. Single-tenant commands do not select this option.
Boot checks the schema and effective role privileges; it does not migrate,
provision, grant, suspend or reopen tenants.

The first reference requires direct PostgreSQL connections. Each selected lower
connection checks that `pg`'s connection PID equals PostgreSQL's actual backend
PID. Transaction-pooling proxies are refused rather than silently adopted. The
restore census matches backend PID, backend birth and database role across all
selected clinical, authorization, checkpoint, outbox and suppression schemas.
Application names do not establish membership. Current unknown actors refuse
restore. This census is a diagnostic and refusal check on observed sessions; it
is not a database fence against a new authorized client connecting afterward.
Role memberships that could acquire table privileges through `SET ROLE` are
included in the actor census.

An outer operation remains durably unfinished until its callback, HTTP response,
private IPC response or socket acknowledgement completes. Lower SQL transactions
hold the same tenant's shared admission lock. Restore requires the controller's
exclusive claim and a drained complete cooperative cohort. Suspension and unresolved orphan
operations survive process failure; shutdown does not automatically reopen them.
Successful restore invalidates the selected tenant's retained evaluator output,
notification intents, realtime projections and sockets. Other tenants retain
current process state. Fresh clinical acquisition rebuilds the restored tenant's
output; the retained-time evaluator timer does not substitute for acquisition.

The deployment contains a fixed set of authorized components with custody of
their DATA/lifetime database credentials or equivalent authentication identities.
Every component must boot through the selected window. Private database ingress
and a separately trusted maintenance operator remain deployment responsibilities;
boot cannot verify credential distribution. Independent raw clients sharing DATA
authority can bypass this cooperative protocol. Supporting those clients requires
an additional database or authentication fence; process separation itself does
not require that fence.

Version 2 adds `participantId` and `participants` to the version 1 configuration.
Each participant has `id`, `roles`, `namespaces`, `socketPathEnv`,
`maxMessageBytes` and `timeoutMs`. The process's actual selected roles and all
clinical, authorization, checkpoint and consumer namespaces must match its entry.
Each participant publishes only source-owned status and tenant-invalidation
operations after its actual role constructors complete. The shared socket volume
requires the same numeric UID, private directories with mode 0700 and socket files
with mode 0600. The transport refuses replacing an existing endpoint. There is no
public listener or arbitrary quiescence callback.

The controller constructs `createRemote({namespace,tenants,participants})` from
that fixed manifest. `pin(cohort,tenant,{client})` returns an opaque registration
held through the restore and released with `releasePin`. Status requests collect
actual local lower-backend identities and pin each process's boot incarnation and
admitted window schema identity. Window readiness also freezes its own actual
datastore tuple; every upper lifetime and lower lease must match it, so matching
schema OIDs on a different PostgreSQL instance do not establish membership. Each check also compares the peers' actual
database name/OID, server address/port and postmaster birth with the controller's
current connection. Direct access to the same database endpoint is required;
ambiguous endpoint identity refuses rather than inferring sameness from config.

After DATA commit, the controller awaits fresh A invalidation acknowledgements
from every configured participant before activation. The fixed control handlers
invoke the actual local role invalidators; replies echo a fresh request nonce and
the pinned incarnation/schema identity. Missing peers, observed restarts, changed
identity, malformed or lost acknowledgements refuse activation and retain A's
committed suspension. B has its independent window and continues operating. Pins
are tenant-specific and released after cleanup, so a fresh restore can explicitly
register current incarnations after an earlier attempt ends. Dynamic membership,
autoscaling and automatic orphan recovery are outside this first manifest.

## Failure recovery and shared-role restart boundary

The bounded continuity claim is that B continues while the configured cohort
remains running. **Read-derived limitation:** current API startup performs guarded
legacy/authority preparation for every configured tenant; realtime startup checks
checkpoints and acquires initial frames for every tenant. If A remains suspended
after a failed restore, that refusal can prevent a shared role from restarting,
including B's listener. The running-cohort proof does not establish independent
B restart availability or automatic recovery of a suspended tenant.

Pending operations, uncertain outcomes and suspension must not be cleared merely
to make startup succeed. This preview does not provide an automatic orphan clear
or a suspended-restore resume command. Operator-verified recovery and independent
restart admission remain separate work; no HA or deterministic recovery bound is
claimed. Ordinary successful tenant-local restoration requires no global pause.

Shutdown quiesces and drains role resources before releasing the cohort registry.
A failed database-pool drain leaves the registry selected and blocks an
unwindowed fallback. This reference assumes trusted service roles and private
transport ownership. Cross-process coordination uses the fixed private participant protocol above.

Source protocol checks are in `tests/operation-cohort.test.js`, `tests/operation-cohort-peers.test.js`,
`tests/tenant-operation-window.test.js`, `tests/evaluator-preview-runtime.test.js`
and `tests/realtime-preview.test.js`. Recording SQL and role constructors do not
establish native PostgreSQL readiness or end-to-end restore acceptance; the
coordinator runs those on the coherent joined candidate.
