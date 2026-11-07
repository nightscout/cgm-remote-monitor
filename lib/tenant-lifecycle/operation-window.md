# Tenant operation window — isolated prototype

Source-only incremental protocol. Same-ID identity-bearing import remains
`LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED`. No CLI/configuration parser selects this
adapter, and current preview roles do not claim a complete restore fence. The
appended lifecycle-control migration supplies prospective tables, backend-owner
RLS and a narrow helper. Native SQL execution, catalogue deparsing, role grants
and RLS enforcement remain UNMEASURED. A complete serving cohort and private
operator controller remain required before use.

The private composer supplies `create({namespace,locks,pool})`: a dedicated raw pg
pool, an explicit control namespace and `locks` containing `{tenant,key}` rows
with a unique positive bigint-string key for every selected tenant. Tenant A and
B have distinct keys; no global allocator lock or B outage is selected. Before
lower-port installation it must await `window.ready()` (resolves without a value).
That method reads metadata directly through the dedicated pool, without the lower
connection module, so it must precede global lower-port installation.
`window.namespace` is immutable. `window.identity` is initially null, then a frozen
object with namespaceOid, ownerOid, ledgerOid, windowsOid, operationsOid and
backendBirthOid. Each acquired backend is readmitted against that identity.

The new control tables are tenant_lifecycle_windows
(tenant_id,lock_key,phase,generation,claim_id) and tenant_lifecycle_operations
(tenant_id,operation_id,generation,finished,owner_pid,owner_birth). The windows
phase and claim are coherent; lock keys and generations are positive. Both tables
use forced tenant-bound RLS. INSERT and UPDATE operation policies additionally
bind owner_pid and owner_birth to the current backend's PID and birth timestamp;
a replacement backend cannot finish an earlier backend's orphan. The serving
INSERT omits finished and both owner columns so database defaults establish them.
The SQL stable SECURITY INVOKER birth helper has a fixed pg_catalog search_path
and PUBLIC execution revoked. There is no operation deletion or orphan-clear API.

Read-only admission checks the exact lifecycle migration ledger, column shapes,
defaults, keys, constraints, policies, helper definition and grants, relation
identities and shared schema/table/helper owner. That owner must be a dedicated
nonlogin, nonelevated role. Callers cannot own these objects, inherit elevated
roles or CREATE schemas/database objects. The dedicated lifetime role needs
schema USAGE; SELECT on windows, operations and schema_migrations; column INSERT
on operations(tenant_id,operation_id,generation); column UPDATE on
operations(finished); and EXECUTE on the birth helper. Table-level mutation,
foreign relation/sequence writes and execution of other non-system functions
refuse, including effective privileges inherited through PUBLIC or memberships.
Lower data roles need only USAGE and SELECT on these control relations, with no
operation writes or helper EXECUTE. Their clinical-data grants remain separate.
A table name is not authority to create or adopt unknown schema. These checks
have source/catalogue protocol controls; their native enforcement is unmeasured.

The lower PostgreSQL connection can explicitly select operationWindow. It acquires
a nonblocking shared session lock BEFORE BEGIN, then binds the tenant and checks
current control state before any body SQL. This order matters for REPEATABLE READ:
a transaction must not take a stale snapshot before lock acquisition. It releases
after COMMIT/ROLLBACK and evicts a backend whose unlock fails. Snapshot, plain query,
withTenant, transaction and savepoint entry all use that common lower boundary.
An unconfigured connection still has its existing contract; it is not a fenced
connection and must make future restore admission fail.

A serving operation additionally runs inside window.run(tenant,callback). Its
pending-operation record commits BEFORE the callback starts. The shared lock and
record cover HTTP response finish, socket acknowledgement/fanout/alarm, evaluator
cycle and producer/retry/adapter handoff where explicitly composed. Nested same-
tenant work shares an outer lifetime; cross-tenant reentry refuses. Retained
synchronous evaluator/realtime output is available only inside a current lifetime.
A lease transport error invalidates scope and can close an owned transport, while
leaving the durable pending record unresolved. Lease absence alone never proves
that an HTTP/provider callback has finished.

The proposed private maintenance order is: durably stop new A admission, drain
actual operation records, acquire A's exclusive lock using nonblocking attempts,
then recheck the exact generation/claim and all unfinished A operations. A lost
connection/orphan operation means refusal, not an expiring marker, automatic
cancellation or a guessed window. Existing privileged/DDL actors and every serving
connection/role still need complete census and admission. Uninstrumented workers,
raw SQL authority, schema drift and unknown cached allocator sessions refuse before
restore effects. There is no restore API in this module and no operator lock/claim
implementation yet.

R74 disqualifies clock-only fences and tenant-local sequence rewind. A covered
counter and current CACHE1 metadata alone do not prove old backend caches empty.
Any future no-sequence-mutation import must retain exact artifact ordinals and
prove both cache history/backend conditions and a covered effective next-value
floor; otherwise refuse. No setval/ALTER/renumbering workaround is enabled here.

Focused source tests distinguish protocol doubles from PostgreSQL evidence.
Comprehensive acceptance is deferred until the coherent source/role integration
is frozen; this isolated prototype is not a completed M6 capability or promotion.


The subsequent source prototype adds a private lower-port installation scope:
when the boot coordinator selects an actual live window, every subsequently
constructed common PostgreSQL connection uses it, including helpers that omit
the per-connection option. Replacing it or installing a fabricated/closed window
refuses; only the owning closure clears that installation. Existing connections
retain their selected adapter. No CLI installation is enabled. The reserved all-zero startup binding may only
enter an explicitly requested and DB-confirmed READ ONLY transaction; it is
forbidden as a serving-tenant lock binding or operation lifetime. Other unknown
tenants refuse. This admits metadata screening, not a missing control schema or
a serving cohort. This central coupling does not prove
that direct pg clients, older workers or an entire deployment are admitted.
