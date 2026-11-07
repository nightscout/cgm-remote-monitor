# Whole populated C recovery: source boundary and proposed native plan

Status: SOURCE-ONLY. No runtime, image probe, build, dependency change, fetch,
prcheck, full suite, browser or corpus campaign is authorized by this plan.
The coordinator reviews the frozen source/inputs before granting services.
The accepted f77 representative proof remains frozen and is not repeated here.

## Join and entry points

The lane starts at accepted A74 `74d7b3fc25c7e3c496c438847c95e89ec7fe6061`, joins R69
`fd827e350a185ad73c838b013b25fe889434b036` and f77
`f77c025f8e797775faca0e179cc84fc3ca9c5874`, then explicitly joins c48
`c48d4d197e5ae6880bb48bad78a9f0821f6fb2a8`. The later source-only audit/documentation
fixes are retained without relabelling f77's historical execution.

`createDeploymentOperations` composes dynamic source admission, the existing
operator migration runner, durable filesystem callback and original-ID restore.
`deploymentAdmission` also returns a tenant lifecycle instance for the same reviewed
extensions. It adds the separate lifecycle ledger only to deployment backup.
No active M5 worktree is imported and no application serving/default path changes.

Current read-derived inventory is 22 JSON candidates / 20 selected kinds / 35
selected tables; two socket-order successors are explicit alternatives. A74 owner
configuration authority was missing from old R69 inventory: the new independent
source check failed before its joined-tree repair. The current extension interface
refuses unknown new candidate paths, missing namespaces and incomplete table lists.

## Frozen recovery catalogue inputs (not whole M5 runtime integration)

The reviewed alarm source is `e9121a6e2e4b857701df8e443d831e794b68c03c`, candidate
`migrations/candidates/postgres-alarm-suppression-v1.json`, table
`tenant_alarm_suppression`. Source-only inputs are prepared in
`tests/fixtures/tenant-deployment-alarm.js`, with its exact candidate snapshot in
`tests/fixtures/tenant-deployment-alarm-candidate.json` for focused admission tests.
The exact frozen alarm and notifier candidate JSON is now present as recovery
input; actual alarm/notifier runtime modules are NOT merged into this C operator
tree. Alarm schema pin remains e912; its narrow writer additionally receives SELECT
on its own migration ledger for the reviewed e016 selected-datastore check.
Writer S/I/UPDATE(acked_at,expires_at), reader SELECT, realtime none remain unchanged.

Notifier input is `d06c990ca2c00e8689be5c56e37301f5c71ffc67`, exact candidate
`lib/tenant-notifications/postgres-candidate.json`, heads/requests tables.
`tests/fixtures/tenant-deployment-notifications.js` pins canonical and byte digests,
contains both normalPolicy prefixes in dedup_key (no invented policy column), and
supplies pending/attempting/uncertain/accepted/cancelled/head/receipt rows. Dedicated
outbox grants are schema usage, ledger SELECT, both tables SELECT/INSERT; heads
UPDATE(request_id,blocked_until); requests
UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at).
No table-wide UPDATE/DELETE/DDL or checkpoint-principal reuse is supplied.

The complete proposed seed accepts an explicit `now`, so a native runner can use
the common actual PostgreSQL epoch for alarm/outbox state. All extension changes
refuse until digest re-admission. Final full C archive must merge the actual final
B runtime and re-census, including the forthcoming append-only notifier0002
transition-state contract and any profile schema change justified by its early
native comparison. This recovery-input preparation is not joined M5 acceptance.

## Preconditions to freeze for native review

1. Root joins the actual final B runtime and supplies any remaining realtime/
   profile schema change. The frozen suppression/outbox inputs above are prepared;
   census the exact final merged source again. Do not invent a synthetic replacement
   migration or copy an agent's active uncommitted schema.
2. Select OLD and NEW immutable source archives and exact namespace maps. OLD is
   the complete currently installed admission; NEW adds the actual reviewed table/
   namespace transition. Existing catalogue changes must retain checksum prefixes,
   names and existing tables. A missing OLD ledger or occupied NEW namespace refuses.
3. Finalize the full seed and explicit privileges against those inputs. The proposed
   `tests/fixtures/tenant-deployment-data.js` has rows for every current table and
   both synthetic tenants, including typed twins, null/false/zero/array values,
   parent/FK rows, versions/history, opaque ciphertext/key references, checkpoint
   state and executed lifecycle requests. It has not run against PostgreSQL.
   Its placeholder policy digests are SQL-fidelity fixtures, not an owner-policy
   runtime-readiness claim; use real catalogue digests for any consuming-owner case.
   M5 extensions must supply explicit additional rows and meaningful state.
4. Use one privately owned PostgreSQL fixture at a locally recorded image identity,
   matching private dependencies and private artifact root. Clear caller DB env;
   no pull/provider/production endpoint or default role enablement. Track exact
   resources/process births and preserve every unknown baseline resource.

## Explicit privilege matrix to bind at the frozen join

Use preexisting freshly provisioned NOBYPASSRLS application roles and the exact
caller-supplied grants below. Role names are fixture-selected; rights are inputs,
not new defaults. If the current consumed composition uses one actor for more than
one narrow capability, record that intentional union rather than broadening a
schema wildcard. Backup/migration operator identity remains separate.

| Capability | Positive grants | Required refusal |
|---|---|---|
| Clinical DATA reader | SELECT on the seven clinical/document tables; any clock read declared separately | INSERT/UPDATE/DELETE on clinical data, authority, secrets, checkpoint, ack/outbox |
| Clinical DATA writer | Explicit SELECT/INSERT/UPDATE/DELETE per clinical table; clock SELECT/INSERT plus UPDATE(last_stamp); identity sequence rights only where needed | Authority/settings/secrets/lifecycle/ack/outbox writes |
| Evaluator source reader | SELECT on its actual admitted clinical inputs and clock | Every clinical-source write; authority/settings/secret writes |
| Checkpoint bookkeeping | SELECT plus UPDATE(checkpoint,projection,contract_digest) on tenant_consumer_checkpoint | Clinical writes, other columns/tables, foreign tenant checkpoint changes |
| OWNER access reader | Explicit SELECT per consumed authorization/access/legacy/policy table | DML, secret reveal or clinical write from that role |
| OWNER subject writer | Existing subject/legacy-subject SELECT/UPDATE/DELETE, subject-role SELECT/INSERT/DELETE, subject audit INSERT, owner_fence column-only updates as required by accepted A74 | Other authority columns, owner configuration state, clinical/secrets writes |
| Versioned settings writer | tenant_settings SELECT/INSERT/UPDATE; history SELECT/INSERT; required policy SELECT and owner_configuration authority SELECT/UPDATE(owner_fence); own ledger SELECT | Alter can_configure/active/principal, clinical writes, secret access |
| DATA presentation reader | SELECT tenant_settings and required policy/own ledger metadata only | Any INSERT/UPDATE/DELETE, authority-bit mutation, clinical/secret writes |
| Alarm writer/reader | Exact e912 table rights above plus writer-only own ledger SELECT (e016) | Reader DML; writer broad UPDATE/DELETE; wrong datastore/foreign/authority writes |
| Dedicated outbox | Exact d06 table/column/ledger grants above, separately from checkpoint writer | Broad UPDATE/DELETE/DDL/ownership/BYPASS/membership and writes outside outbox |
| Deletion request/cancel | Current-authorized request fields and pre-start cancellation fields only; no clinical DELETE | Operator confirmation/start/finalization columns and all destructive effects |
| Deletion operator | Separately current-authorized confirmation/claim/execution plus verified artifact/window; explicit reviewed ceremony/request update columns and tenant DELETE | Execution from owner route, cancellation after durable start, stale authority/artifact/window or omitted inventory |
| Other metadata/secrets/lifecycle tables | No automatic application grant; any consumed private capability must be enumerated before its acceptance claim | No schema-wide or blanket automatic grant |

`acl.grants` supports table and validated column privileges; schema USAGE is only
for named role/kind. Migration ledgers accept SELECT only. Sequence grants resolve
only the named table's real identity sequences before writes. No wildcard, ALL,
DDL, role membership, BYPASSRLS or default broad grant is emitted. Probe actual
PostgreSQL has_table_privilege/has_column_privilege plus real allowed and denied
SQL under tenant binding. Metadata claims alone do not prove denial. Tenant A and
B are tested independently; RLS refusal/zero-effect must retain the foreign oracle.

## One focused populated native capability sequence

The independent oracle uses a second operator connection and explicit raw column
queries, not the artifact's summary implementation. It freezes per-tenant counts,
row/typed identities, logical values, FK relationships, original clocks/checkpoints,
versions and opaque ciphertext/reference bytes. Store only sanitized aggregates
and hashes publicly.

1. Provision the complete OLD inventory and seed every table, including both
   tenants and a separate historic tombstone case whose tenant registry is absent.
   Use no blanket registry-membership assertion that would discard that tombstone.
2. Capture through the durable callback. Independently read files after all handles
   close, validate digests and original IDs, and compare source SQL versus artifact.
   Use actual filesystem faults at write/fsync/rename/readback boundaries; no up may
   occur on refusal. An interrupted staging write leaves no published artifact;
   post-rename sync refusal retains inspectable data without reporting success.
3. Restore to fresh OLD namespaces with the explicit privilege matrix. Compare raw
   SQL/FKs, all per-tenant data and generated identity/next-insert behavior. Run
   denied-write/foreign-state checks. Interrupt restoration after data has changed,
   verify no partial rows/grants, rerun and compare. Sequence rollback limits remain
   explicit. Tampered files must refuse before INSERT/GRANT/setval.
4. Upgrade from actual populated OLD admission to NEW containing an actual new M5
   table/namespace. Persist only OLD before any mutation, verify exact retained old
   artifact and check all NEW ledgers/tables. Independently project OLD columns
   from NEW and require every original row/identity/value to survive. Preserve any
   failed attempt and partial runner state; do not down-migrate in place.
5. Execute the OLD operator binary's checkRecord against the NEW record and require
   unknown/newer-catalogue refusal. Its per-namespace migration checks alone cannot
   detect a whole added kind. This is explicit operator readiness, not an implicit
   serving-boot gate. Record NEW writes after backup, then rollback with the matching
   record into fresh OLD namespaces. OLD check is current there; original snapshot
   is restored; upgraded data/new namespaces remain untouched for investigation;
   post-backup loss is explicit. No cross-tenant clone or key rehoming occurs.
6. Run meaningful archive-only source mutants covering omitted admission, missing
   durability, old/target-inventory confusion, lost-row/oracle failure, interrupted
   rollback and privilege broadening. Require intended assertion plus independent
   physical evidence, not a timeout/setup/TypeError. Restore the source after each
   family, then run the complete unmodified populated capability suite once on its
   final frozen head. Do not rerun the representative f77 lab or broad campaigns.
7. Independently verify exact container/volume/network/child absence, preserve the
   failed captures and release the slot. Coordinator records the one capability
   verdict/evidence bundle and chooses the coherent Batch C integration boundary.

## Outside this grant

Key destruction/after-window refusal needs the separately approved retention/provider
capability. No provider, automatic revoke/destroy, ownership or backend policy is
chosen. Production power-loss guarantees, numeric capacity/cadence/egress budgets,
owner/OIDC lifecycle and actual client/journey equivalence remain separate explicit
acceptance families. The coordinator may reuse the existing pure journey request
builders for restored/rollback single-versus-multitenant comparison after assembly;
the old Mongo-only launcher is not an unchanged PostgreSQL recovery instrument.

## Adopted ceremony in this recovery input

[Lifecycle CEREMONY.md](../tenant-lifecycle/CEREMONY.md) defines the append-only0002
state machine and native race/retry plan. Include both lifecycle tables in full
backup. The exact cancellation cutoff is a separately acknowledged start COMMIT;
a failed destructive transaction keeps executing state and cannot reopen cancel.
Confirm/request/claim/execution can occur at the same instant; no mandatory wait.
Legacy pending intent requires confirmation and current full artifact admission.

The native grant must bind a real current-authority adapter in the operation's
transaction, a real durable tenant artifact verifier and a controlled quiescent
operator-window capability. Current fixtures/protocol hooks are not production
identity or D15 blackout. Prove the same-row cancellation/start race with separate
connections/barriers; authority revocation, storage/window loss and late writers
must refuse before DELETE and preserve foreign state. Interrupt after the durable
start and during deletion, observe persisted claim/rollback, then retry only with
current operator authority and the same artifact. Keep inherited R69/f77/a7/b0
captures at their original scope. No new native/comprehensive campaign is granted
by this source plan.

## Journey-map compatibility supplement (proposed; UNMEASURED)

Use alignment `tools/review/journey-lab/clients.js` pure descriptors and the
step/readback definitions in `journey.js`, not the Mongo-only `lab.sh` launcher.
Freeze both alignment descriptor head and final application head before runtime.
Replay the identical synthetic descriptors/time under same-head single-tenant
Mongo, original multitenant PG, fresh restored PG and OLD rollback PG. Provision
tenant credentials through each actual admitted authority interface. Do not reuse
one backend's bearer material on another; preserve each descriptor's auth shape.

| Consumer/descriptor | Actual boundary and independent observation |
|---|---|
| Loop/Trio connect/onboard/backfill | GET experiments/test and profile/current; POST profile/profile.json and treatment/entry/devicestatus descriptors; read profile history, exact typed stored rows and v1 response shapes. |
| AAPS3.4 v3 /4.0 descriptors | Token request/Bearer path and actual v3 create/update/history selectors; retain returned identifier/version mapping across subsequent descriptors and restore. Unsupported routes remain explicit. |
| AAPS v1 socket descriptors | Actual authorize and descriptor event/collection/ack; record ack and persisted effects, replay/retry identity, tenant isolation. No HTTP substitution for socket evidence. |
| Followers/readers | LoopFollow query token, nightguard raw API-SECRET token and JWT request, Reporter query shapes; compare response status/body/order, content type and relevant auth/cache headers. |
| Alarm/normal/ack/retry | Drive actual consumed evaluator with synthetic boundary readings and actual ack path; compare observed alarm/clear_alarm payload/order with legacy, and independent suppression/outbox rows, claims/retry receipts and consumer delivery capture. Use the final notifier transition schema and actual selected principal. |
| Recovery/deletion | Replay admitted reads/writes before backup, after fresh restore, after failed upgrade/OLD rollback; verify history, identifier links and foreign tenant unchanged. After deletion, prove actual tenant admission/read/write/notification refusal and retained audit/artifact identity. |

Record endpoint, descriptor source citation, backend/head, tenant class, synthetic
clock, request descriptor hash, status/body/headers, independent stored/history
comparison, consumer capture and resource cleanup. Redact credentials entirely.
Normalize only captured clocks/generated IDs via explicit stable correspondence;
never normalize ordering/type/null/false/zero, headers or missing history away.
Classify each result: equal, intentional decision-linked difference, preserved
legacy quirk, unsupported or UNMEASURED. Plant one admitted typed/history loss and
one alarm-clear/retry loss; require exact oracle failure and restored passes.
Source-pattern request replay is client-shape evidence, not execution of actual
mobile binaries. Provider sends, browsers and real mobile clients require their
own scope; this supplement does not claim those ran.
