# Private A-only restore controller

The controller composes a current private PostgreSQL role, committed tenant
suspension, an exclusive tenant advisory lock, a same-backend
restore transaction, and the source-created co-located role cohort. It does not
use a global write pause or treat a callback's `quiesced:true` as evidence.

## Interface and authority

`create({namespace,locks,pool,cohort,drainTimeoutMs})` requires an explicit positive
representable timeout (maximum2147483647 milliseconds); no default or recovery-time
budget is adopted. The first-reference private pool has maximum one client. The opaque cohort pin remains held through all checks/effects and is released in
finally before destroying the client, including failures. Each
checked-out controller backend is destroyed after success or failure, avoiding
unregistered privileged idle actors. The caller owns and closes the pool.

`withRestore(tenant,{artifactDigest},fn)` passes `{connection,maintenanceClaim}`.
The connection joins the controller's already-bound transaction; it cannot issue
independent BEGIN/COMMIT/ROLLBACK or retain authority after the callback. The claim
is a frozen opaque object in a private WeakMap. `assertHeld(claim,{connection,
tenant,artifactDigest})` rechecks the exact backend PID/birth/role, current operator
authority, phase/generation/claim/digest, audit state, exact exclusive lock
and the registered cohort census.

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

1. Pin the source-created participant incarnations/schema identities using the held
   private client, then verify the branded complete cohort, exact schema
   and current role authority. Try the exclusive generation lock. A transaction
   already committing under its shared counterpart causes a refusal while A is
   active. Otherwise commit the new suspended generation, claim, artifact digest
   and audit record together.
2. New serving operations on A refuse. Try A's exclusive replacement key until
   the bounded deadline so a previously admitted transaction can finish rolling
   back. A timeout leaves A suspended. Responses for writes that committed before
   suspension can complete while restore proceeds. Queued alarms keep their origin
   generation through transport acceptance.
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

Nothing here retries, reclaims or recovers automatically. A normal pre-activation
failure leaves the committed window suspended; errors after the data commit can
leave restored data with that suspension. The way out is the operator's
[resume](#resume-and-operation-clearance). COMMIT response loss is not proof of
rollback: dedicated SUSPENSION/DATA/ACTIVATION_OUTCOME_UNCERTAIN errors retain
cause information and require explicit persisted-state inspection. Activation
response loss may mean A is already active, but activation was issued only after
restore and awaited real invalidation. Do not auto-reissue the restore or report
an uncertain activation as a confirmed suspension. Cleanup errors remain visible.

The same database/pool remain shared resources. Caller-selected drain timeout
bounds acquisition of the replacement key, not restore completion. A hung external dependency or
transport loss is not made safe by reopening on a watchdog deadline.

## Resume and operation clearance

`restore-resume.js` `create({namespace,locks,pool,cohort})` gives the private
operator three operations (decision `restore-resume-and-precheck`). Each runs on
one operator backend that is destroyed afterwards, under current restore
authority and the maintenance schema admission. The two that write also hold the
cohort pin, so every participant in the fixed manifest has answered now with one
schema identity and datastore.

`inspect(tenant)` reads and reports the window phase, the claim, the restore
audit state, whether the restore's owner backend is still present, the count of
unfinished operation records, and the refusal reasons a resume would give.

`resume(tenant,{claimId})` reopens a tenant whose restore owner is gone. The
operator names the claim they inspected. The audit state decides the case; the
data transaction sets `restored` in the same commit as the replaced rows.

| audit state | case | what resume requires before reopening |
|---|---|---|
| `suspended` | closed before the data was replaced | exclusive key, awaited participant invalidation and fresh census. Suspension advanced the generation |
| `restored` | data already replaced | exclusive key, awaited participant invalidation and fresh census. The resume row records that replacement committed |

It refuses when the restore's owner backend is present or its birth cannot be
read (`LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT`), when the claim is another
database role's (`LIFECYCLE_RESUME_AUDIT_UNAVAILABLE`), when a participant does
not answer, and when another restore or resume holds the window row. The window
update and one row in `tenant_lifecycle_restore_resume` commit together; a claim
has at most one resume row, and the row policy accepts only the label that
matches the audit state. The restore audit row is not rewritten. Publication
hooks a restore queued with `afterCommit` are not replayed.

Restore and resume use tenant transaction fences. The operator can inspect and
clear legacy marker rows independently of either operation.

`clearOperations(tenant)` records, in `tenant_lifecycle_operation_clearance`,
that an unfinished operation record has no owner left. It clears a record only
when no backend can be its owner (the server's session list) and no participant
process reports it among its unfinished operations (`getOperations`, answered by
each pinned incarnation). A record with a present backend is retained as
`OWNER_BACKEND_PRESENT`; one whose process still runs it as
`OWNER_PROCESS_RUNNING`. The original operation record stays available for audit. Inspection reports
the remaining uncleared records.

## Schema and recovery inventory

Lifecycle migration0004 appends windows.artifact_digest, an explicit role-OID
restore-authority table and an audit table with backend birth and durable states.
Existing suspended legacy rows without an artifact digest refuse the new
constraint rather than receive fabricated ownership. Earlier migrations and
checksums remain unchanged. Runtime/lifetime profiles get no new write authority;
a separate strict maintenance profile permits only current window control and
append/update of the private audit's bounded state fields.

Lifecycle migration0009 appends the resume and clearance tables. Both are
insert-only for the operator role through column grants and row policies that
require current restore authority and the inserting backend's own identity.

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
