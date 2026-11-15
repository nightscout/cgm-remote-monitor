# Tenant operation window

The private serving composer uses this adapter to retain tenant restore exclusion
through actual bodies, child SQL and response/provider completion. Ordinary warm
requests use process-owned in-flight accounting and do no lifecycle SQL or lane
admission. A durable marker covers one process's participation in one tenant
generation, from first use until restore drain or graceful process shutdown.
Same-ID identity-bearing import remains `LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED`.
The minimum backend admission change is implemented on a local branch; its new
native PostgreSQL checks and joined acceptance remain UNMEASURED until run.

The private composer supplies `create({namespace,locks,pool})`: a dedicated raw pg
pool, an explicit control namespace and `locks` containing `{tenant,key}` rows
with a unique positive bigint-string key for every selected tenant. Tenant A and
B have distinct keys; no global allocator lock or B outage is selected. Before
lower-port installation it must await `window.ready()` (resolves without a value).
That method reads metadata directly through the dedicated pool, without the lower
connection module, so it must precede global lower-port installation.
`window.namespace` is immutable. `window.identity` is initially null, then a frozen
object with namespaceOid, ownerOid, ledgerOid, windowsOid, operationsOid,
authorityOid, auditOid, resumeOid, clearanceOid and backendBirthOid. Each physical backend receives full structural and grant admission before its
first operation. Admission is internal to the window and bound to the raw client,
backend PID and principal OID. Error/end, changed PID and datastore recovery
invalidate it. A different physical client cannot reuse another client's admission.
Lower connections perform admission during startup/backend observation; lifetime
sessions perform it before acquiring their first operation lock. No catalogue
digest, TTL, global membership/object sweep or CDC invalidation runs per operation.

Inside every transaction, after the shared lock and tenant binding, one statement
checks the admitted current role OID, SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/
REPLICATION flags, membership of the fixed control owner, backend PID, datastore
identity and typed tenant window key/phase/generation. Metadata work instead
checks READ ONLY status. PostgreSQL privileges, forced RLS, current actor authority,
actual COMMIT, durable markers, response-inclusive completion and restore fencing
remain live. The suppression reader's constructor-only backend callback checks
its full shape/grants/ledger before use; snapshots continue reading actual rows.

Protected DDL and grant expansion require deployment/migration to retire affected
serving cohorts and re-admit them. Arbitrary trusted administrator schema, policy,
ledger or extra-grant changes on an already admitted backend no longer guarantee
custom rejection on its next transaction. PostgreSQL still enforces actual revoked
privileges on executed commands; this is not equivalent to detecting a DBA who
weakens a policy while leaving SELECT permitted. CDC does not observe every role
or DDL mutation. New/reconnected backend admission rejects unsafe structure.
Ordinary runtime roles cannot alter protected control-owner objects or create in
application schemas. Database TEMP, self-password and permitted session defaults
are narrower capabilities; qualified SQL and fixed search paths remain required.
The pgstream replication role can create/alter its own objects in its own schema,
without control ownership; unrelated catalogue growth does not invalidate warm
serving backends. Setup-only restore commissioner BYPASSRLS is not a runtime role.

The private composer may select `trustedWorker: true` for a verified evaluator.
It adds the joined operational verification boundary below; it uses the same live
principal/tenant fence and backend admission as public/routed windows.

The worker coordinator must call
`window.verifyOperational(async () => { await readopt(window); await trusted.verify(); })`
with the selected lower cohort's `readopt(window)` at startup, recovery and the existing bounded
worker operational cadence, outside tenant execution budgets. The first method
rechecks the lifetime role's complete catalogue admission and datastore identity;
the latter reobserves each live lower pool and calls `window.verifyClient(client)`
to recheck its lower admission. Admission remains withdrawn until the lifetime admission and the complete
related-verification callback both succeed. Concurrent verification cannot reopen
admission while another check is pending or after one fails. A verification
failure withdraws trusted operation admission. Successful lower verification alone does not reopen it. The coordinator
must withhold worker output during this joined verification and resume only when
all checks pass. Catalogue drift is detected at this operational boundary or at new backend
admission; public operations do not promise next-transaction DBA-drift refusal. This is an explicit process capability, never inferred from
an ambient tenant lifetime.

A tenant's first operation commits one participation marker before any body
starts. It then releases the registration advisory lock. Later overlapping or
sequential bodies reuse the marker with no lane job, INSERT, UPDATE, transaction
or advisory lock on the outer request path. The first-use promise prevents
concurrent requests from registering the same process/tenant twice. Lower SQL
continues through its own current authorization, forced RLS, shared lock and
generation checks. A lower transaction inside a body also matches that body's
generation, including public API work; trusted workers no longer borrow an outer
advisory lock. Physical children admitted before the body returns keep its
process-owned accounting alive until they finish. Escaped late children refuse.

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

A serving operation runs inside `window.run(tenant,callback)`. It has a distinct
process-local scope covering HTTP response finish, socket acknowledgement/fanout/
alarm, evaluator cycle and producer/retry/adapter handoff where composed. Nested
same-tenant work shares that body; cross-tenant reentry refuses. Retained output
requires a current active body. A participation backend error/end invalidates its
bodies, invokes transport invalidation and refuses new bodies. Actual running
callbacks still drain; a missing connection never proves completion. A failed or
ambiguous registration COMMIT never starts a body. A failed/ambiguous completion
poisons its owner and never claims success or rewrites an uncertain durable result.

Restore durably suspends A before polling every pinned participant's existing
`getOperations` control RPC. That RPC calls `drainTenant(A)`, which reads the actual
DB phase. An active tenant census leaves admission open. A suspended tenant closes
local admission, drains actual bodies and physical children, then finishes its one
marker. The marker stays in the RPC response until completion settles. Restore
waits for both process drain and unfinished durable markers, then takes A's
exclusive key, rechecks authority/generation/claim and performs data effects.
Participant loss, a changed incarnation or unknown writer still refuses. B stays
independent. Invalidation retires drained local participation before activation;
the next first use reads the fresh generation. Both interrupted restore resume
cases use this drain/invalidate order, even when no data was replaced, because
suspension already advanced the generation.

A process/connection loss leaves its durable marker unfinished. Existing explicit
operation clearance requires both the owner backend's absence and fresh pinned
process evidence that its callbacks stopped. Restart and reconnect never clear
those rows. **Tradeoff:** an idle crashed process now leaves markers for every
tenant it warmed on that owner session. Graceful shutdown finishes those markers;
abrupt restart can increase later restore-clearance work. No timer guesses that
an external provider finished, and no callback retry is inferred from a lost
COMMIT reply. This conservatively retains the existing uncertainty behavior while
removing durable bookkeeping from each warm request.

Backend catalogue/grant admission remains at physical startup and operational
verification. Warm outer JavaScript bodies do not promise a fresh DB observation
of phase, arbitrary DBA changes or datastore loss; actual lower SQL remains live
fenced, and operational probes withdraw all affected local scopes on loss. Health,
verification and recovery reuse an owned session for their short control reads,
so a fully occupied operation pool needs no spare checkout. Recovery refuses while
failed bodies still run and publishes a new datastore only after every refusal
boundary passes. Actual performance and joined/native acceptance are UNMEASURED
until the coordinator freezes and measures this source with the other lanes.

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

Catalogue admission compares a bounded structural SQL representation. It preserves
boolean grouping, literal contents and quoted identifier case. Only the selected
lifecycle tables/helper and named pg_catalog builtins admit their corresponding
qualifiers. Unknown syntax and missing catalogue fields refuse admission; explicit
SQL NULL remains distinct from malformed or absent metadata. This comparison does
not infer general SQL equivalence.
