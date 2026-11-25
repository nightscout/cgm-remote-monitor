# Tenant restore and interrupted restore recovery

Restore suspends one tenant, drains its open database transactions, replaces its data and activates the new generation. Serving roles observe generation changes when they admit work.

## Interface and authority

`create({namespace,locks,pool,drainTimeoutMs})` takes the provisioned tenant keys and a positive timeout of at most 2147483647 milliseconds. The caller owns the pool. The controller uses one private backend per restore and destroys it on completion.

`withRestore(tenant,{artifactDigest},fn)` gives the callback a tenant-bound connection and an opaque maintenance claim. The connection joins the open transaction. The controller rejects independent transaction control and closes callback access when the transaction ends. `assertHeld` verifies the backend PID, birth and role, current operator authority, phase, generation, claim, artifact digest, audit state and exclusive lock. Selected native controllers require a verifier for the deployed selection. The paired deployment checks the evaluator contract published by admin on this database and current verification epoch.

The private DDL operator provisions `tenant_lifecycle_restore_authority` rows for
current database role OIDs and selected tenants. The controller reads only its own
active authority and has no grant to modify it. `operatorGrants({namespace,role})`
returns bounded control-table column grants; it does not provision authority,
clinical restore rights, schema ownership or backend-statistics visibility. Role
readiness rejects superuser/bypass, owner/elevated membership and unsafe control
rights.

## Durable ordering and failures

1. Check the control schema and current role authority. Try the exclusive generation lock. A transaction
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
4. Recheck the claim, lock and current authority. Commit activation and its audit state together. Each serving process rebuilds tenant-local state when it observes the new generation.

`connection.afterCommit(fn)` registers through the same private claim/context;
`registerAfterCommit(claim,{connection,tenant,artifactDigest},fn)` is its explicit
branded registration seam. Queued hooks run only after acknowledged outer DATA
commit, before activation. They never run on rollback or an
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

`restore-resume.js` provides inspection and audited activation using the same private operator authority and provisioned keys. A missing owner process does not prove the PostgreSQL backend has gone. Resume checks the recorded backend identity.

`inspect(tenant)` reads and reports the window phase, the claim, the restore
audit state, whether the restore's owner backend is still present, the count of
unfinished operation records, and the refusal reasons a resume would give.

`resume(tenant,{claimId})` reopens a tenant whose restore owner is gone. The
operator names the claim they inspected. The audit state decides the case; the
data transaction sets `restored` in the same commit as the replaced rows.

| audit state | case | what resume requires before reopening |
|---|---|---|
| `suspended` | closed before the data was replaced | exclusive key, current authority and inspected claim. Suspension advanced the generation |
| `restored` | data already replaced | exclusive key, current authority and inspected claim. The resume row records that replacement committed |

It refuses when the restore's owner backend is present or its birth cannot be
read (`LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT`), when the claim is another
database role's (`LIFECYCLE_RESUME_AUDIT_UNAVAILABLE`), and when another restore or resume holds the window row. The window
update and one row in `tenant_lifecycle_restore_resume` commit together; a claim
has at most one resume row, and the row policy accepts only the label that
matches the audit state. The restore audit row is not rewritten. Publication
hooks a restore queued with `afterCommit` are not replayed.

Inspect reports historical unfinished markers and prior clearances. These records remain available for audit. The generation-based operator has no clearance command.

## Upgrading deployments

Stop all processes using the previous operation-window protocol before enabling this controller. Regenerate the serving and operator configurations together and run the admin pre-start verification. A mixed deployment cannot establish that every writer uses transaction-scoped generation fencing.

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
operator authorization. Database recovery preserves control forensic state. The operator separately validates
restored claims before activating a recovered deployment.

## Evidence boundary

The source tests cover commit outcomes, historical marker inspection and backend identity. The native API and resume suites exercise transactions crossing suspension, retryable write refusal, held HTTP responses, offline replicas and audited recovery after interrupted restore.
