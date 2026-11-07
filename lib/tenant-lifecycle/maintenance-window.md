# Private A-only restore controller

The controller composes a current private PostgreSQL role, committed tenant
suspension, durable operation drain, an exact A advisory lock, a same-backend
restore transaction, and the source-created co-located role cohort. It does not
use a global write pause or treat a callback's `quiesced:true` as evidence.

## Interface and authority

`create({namespace,locks,pool,cohort,drainTimeoutMs})` requires an explicit positive
representable timeout (maximum2147483647 milliseconds); no default or recovery-time
budget is adopted. The first-reference private pool has maximum one client. Each
checked-out controller backend is destroyed after success or failure, avoiding
unregistered privileged idle actors. The caller owns and closes the pool.

`withRestore(tenant,{artifactDigest},fn)` passes `{connection,maintenanceClaim}`.
The connection joins the controller's already-bound transaction; it cannot issue
independent BEGIN/COMMIT/ROLLBACK or retain authority after the callback. The claim
is a frozen opaque object in a private WeakMap. `assertHeld(claim,{connection,
tenant,artifactDigest})` rechecks the exact backend PID/birth/role, current operator
authority, phase/generation/claim/digest, audit state, exact exclusive lock, absence
of unfinished operations and the real registered cohort census.

The private DDL operator provisions `tenant_lifecycle_restore_authority` rows for
current database role OIDs and selected tenants. The controller reads only its own
active authority and has no grant to modify it. `operatorGrants({namespace,role})`
returns bounded control-table column grants; it does not provision authority,
clinical restore rights, schema ownership or backend-statistics visibility. Role
readiness rejects superuser/bypass, owner/elevated membership and unsafe control
rights. Root cohort actor census also requires sufficient private visibility of
actual backend births; unknown/NULL actors refuse. Role names and GUC booleans
never substitute for the provisioned current authority relation.

## Durable ordering and failures

1. Verify the branded complete cohort using the held private client, exact schema
   and current role authority. Commit A's suspended phase, new generation, claim
   and artifact digest with an append-only audit record.
2. New A ordinary operations refuse. Poll existing durable unfinished markers and
   try only A's exclusive advisory key nonblocking. Deadline, orphan or unknown
   completion refuses; the controller never clears markers or reactivates A.
3. Restore on the exact held backend. Lifecycle must assert the claim before
   metadata/effects and before commit. Mark audit state restored in the SAME data
   transaction as restored rows. Independent B's operations/key remain unchanged.
4. Await actual cohort cache/socket/evaluator invalidation, recheck the complete
   cohort and current authority, then commit explicit activation and audit state.

`connection.afterCommit(fn)` registers through the same private claim/context;
`registerAfterCommit(claim,{connection,tenant,artifactDigest},fn)` is its explicit
branded registration seam. Queued hooks run only after acknowledged outer DATA
commit, before cohort invalidation/activation. They never run on rollback or an
ambiguous data commit. They cannot reuse the closed restore connection, and must
not require ordinary A admission while A remains suspended. A hook failure can
leave some notifications published with committed data and retained suspension;
there is no exactly-once or automatic publication replay promise. Persisted history
and durable consumers retain their own delivery contract.

No automatic retry/reclaim/recovery API is introduced. A normal pre-activation
failure leaves the committed window suspended; errors after the data commit can
leave restored data with that suspension. COMMIT response loss is not proof of
rollback: dedicated SUSPENSION/DATA/ACTIVATION_OUTCOME_UNCERTAIN errors retain
cause information and require explicit persisted-state inspection. Activation
response loss may mean A is already active, but activation was issued only after
restore and awaited real invalidation. Do not auto-reissue the restore or report
an uncertain activation as a confirmed suspension. Cleanup errors remain visible.

The same database/pool remain shared resources. Caller-selected drain timeout
bounds drain refusal, not restore completion. A hung external dependency or
transport loss is not made safe by reopening on a watchdog deadline.

## Schema and recovery inventory

Lifecycle migration0004 appends windows.artifact_digest, an explicit role-OID
restore-authority table and an audit table with backend birth and durable states.
Existing suspended legacy rows without an artifact digest refuse the new
constraint rather than receive fabricated ownership. Earlier migrations and
checksums remain unchanged. Runtime/lifetime profiles get no new write authority;
a separate strict maintenance profile permits only current window control and
append/update of the private audit's bounded state fields.

These live authority/window/operation/audit relations are excluded from ordinary
tenant clinical restore. Restoring old subjects cannot replace current private
operator authorization. Whole-deployment backup preserves control forensic state
under its separate explicit inventory; it cannot silently activate restored claims.

## Evidence boundary

Source tests model commit outcomes, pending markers, exact backend identity and
awaited invalidation. They stub the cohort module as a protocol model, not actual
role completion. Real backend advisory locks, RLS policies, metadata expressions,
actor census and the complete lifecycle restore require native proof on the
coherent joined source. Full/browser/enabled-corpus acceptance belongs to root.
