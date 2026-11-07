# Whole populated C recovery: source boundary and proposed native plan

Status: assembled SOURCE-REVIEW preparation from BC94c09afdc4466bc2257300570587237d7fb6fed3. SQL-core instrument implemented; native execution remains UNMEASURED. No runtime, image probe, build, dependency change, fetch,
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
Frozen B runtime ancestry is now joined in this source. No active peer worktree is imported or edited; ancestry is not acceptance.

Current assembled selection is 23 JSON candidates / 21 physical instances / 37
physical tables; three socket-order successors are explicit alternatives. A74 owner
configuration authority was missing from old R69 inventory: the new independent
source check failed before its joined-tree repair. The current extension interface
refuses unknown new candidate paths, missing namespaces and incomplete table lists.

## Frozen catalogue inputs (earlier C-only captures remain historical)

The reviewed alarm source is `e9121a6e2e4b857701df8e443d831e794b68c03c`, candidate
`migrations/candidates/postgres-alarm-suppression-v1.json`, table
`tenant_alarm_suppression`. Source-only inputs are prepared in
`tests/fixtures/tenant-deployment-alarm.js`, with its exact candidate snapshot in
`tests/fixtures/tenant-deployment-alarm-candidate.json` for focused admission tests.
The exact frozen alarm and notifier candidate JSON is now present as recovery
input, and the frozen runtime modules are joined in this assembled source. Earlier
C-only capsules did not contain that join and keep their original attribution. Alarm schema pin remains e912; its narrow writer additionally receives SELECT
on its own migration ledger for the reviewed e016 selected-datastore check.
Writer S/I/UPDATE(acked_at,expires_at), reader SELECT, realtime none remain unchanged.

Historical notifier input was `d06c990ca2c00e8689be5c56e37301f5c71ffc67`; its
evidence remains immutable. Current recovery input is
`5600192558a10462c159d00ef53ba770a647765d`, exact candidate
`lib/tenant-notifications/postgres-candidate.json`, heads/requests/state tables.
`tests/fixtures/tenant-deployment-notifications.js` pins canonical and byte digests,
contains both normalPolicy prefixes in dedup_key (no invented policy column), and
supplies pending/attempting/uncertain/accepted/cancelled/head/receipt rows. Dedicated
outbox grants are schema usage, ledger SELECT, both tables SELECT/INSERT; heads
UPDATE(request_id,blocked_until); requests
UPDATE(state,next_at,attempt,attempt_token,attempt_until,accepted_at,receipt,cleared_at).
Worker state SELECT/INSERT plus UPDATE(revision,config_identity,producer);
distinct ACK writer adds only state/ledger SELECT and schema USAGE.
No table-wide UPDATE/DELETE/DDL or checkpoint-principal reuse is supplied.

The complete proposed seed accepts an explicit `now`, so a native runner can use
the common actual PostgreSQL epoch for alarm/outbox state. All extension changes
refuse until digest re-admission. The final executed archive must re-census its exact assembled source, including
both checkpoint instances, notifier0002 and profile successor. This recovery-input preparation is not joined M5 acceptance.

## Preconditions to freeze for native review

1. Root confirms the final assembled B+C head and any subsequent source repair. The frozen suppression/outbox inputs above are prepared;
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
| Dedicated outbox | Exact560 table/column/ledger grants above, separately from checkpoint writer and ACK principal | Broad UPDATE/DELETE/DDL/ownership/BYPASS/membership and writes outside outbox |
| ACK state reader | Producer-state and ledger SELECT/schema USAGE only; existing suppression mutations separate | State INSERT/UPDATE/FOR UPDATE, head/request rights, clinical/checkpoint writes |
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

## Frozen profile successor input (historical C-only preparation, unchanged in assembled source)

Owner `0bf5cf6daef4bd1adc04f0e689ac179ed63283d8`, joined root
`ad3c0b66832a1975638f9a9c0e0e4f3ef510e05b`, supplies exact
`migrations/candidates/postgres-profile-socket-order-v1.json` (byte SHA256
3838b60a7fd4cedbd3297dba6022ddff1ba998895bcf113dc85a4339e295bb08).
The candidate is explicitly pinned as an optional profile alternative. BASE
remains the default. OLD archives without this optional file remain admissible;
selecting it there refuses. Changed valid successor input requires source review.

Unchanged0001 is followed by0002 CHECKfalse validation before adding the bigint
identity ordinal and tenant/ordinal index. Populated BASE upgrade must refuse
atomically: record original rows, columns, guard and ledger before/after, with no
inferred historical order/backfill. Empty upgrade/fresh successor should succeed.
This actual PostgreSQL migration behavior is UNMEASURED here. The source SQL-order
check is not a database execution substitute.

`tests/fixtures/tenant-deployment-profile.js` binds writer/reader/RT rights and
exact profile_insertion_ordinal_seq. Only the API writer receives sequence USAGE;
no reader/RT sequence rights, no sequence SELECT/UPDATE. Explicit API socket
selection applies whole-domain readiness including REST/editor. RT/evaluator must
explicitly select profile in socketOrderDomains (also T/D when used). BASE/default
consumer refuses successor; selected consumer refuses stale BASE. Owner admin is
not a clinical profile consumer. Earlier C-only preparation did not merge these runtime changes. Assembled BC
now includes that runtime ancestry; no generic role union or runtime outcome is implied.

Populate the successor only after fresh/empty migration with
`populatedRows({ profileSocketOrder: true })`: both tenants, typed twins and
noncontiguous ordinals. Source recovery check retains exact ordinal gaps and
foreign rows, advances next identity above max, and emits exact writer-only
sequence grant. Planted pin bypass, ordinal loss and skipped sequence recovery
must red then restore. Native must independently inspect ordinals/next writer
insert, exact grants/denials and actual selected consumer startup, then replay
unchanged profile empty/addretry/preseed-b-then-a requests and record raw replies
and physical state. Existing populated OLD profile remains on its prior catalogue
unless an independently reviewed provenance migration is supplied; don't label a
refused populated upgrade successful. Final consumed runtime equality/admission review is still pending; schema560 is frozen.


## Frozen notifier0002 input (historical C-only preparation, unchanged in assembled source)

Exact consumer source5600192558a10462c159d00ef53ba770a647765d candidate byteSHA
0d998333640f4415dfb93edd789edb0277c1067ccd79f8583f902b3e1b0e1ec2,
canonicalSHA6373384e7e3c7e4059d2d1bd01cd36d29a38964bd96a1a239f28438d598d563b.
Exact0001 remains unchanged; append0002 producer-state checksum
abd52ebd614047bb3f0b751fc1fa7fd0ce9518351560af144c14d7ced1c4cf6d.
Both heads and requests must validate falseguards before state creation, so any
populated predecessor refuses atomically rather than assuming missing private
provenance is empty. Native must independently capture rows/columns/ledger/guards
before and after each populated-head and populated-request refusal; empty
predecessor succeeds. No historical private-state importer is supplied.

New tenant_notification_state has tenant/consumer primary key, positive revision,
config identity and JSONB producer. The complete both-tenant seed retains alarms
with lastAckTime/silenceTime/lastEmitTime, stable pending clear effects/origins,
ACK keys, output cycle identity and separate clinicalIdentity. Bounds/configuration
are explicit native inputs; these synthetic fidelity rows are not a successful
runtime producer-readiness claim. Preserve all JSON values and revisions exactly
through fresh restore and OLD rollback; do not infer empty private state or rewrite
JSON key ordering into false data loss. Earlier d06 artifact/pins remain in their
immutable capsules and must not be relabelled as schema560 evidence.

Outbox worker gains only state SELECT/INSERT and UPDATE(revision,config_identity,
producer), ledger SELECT/schema USAGE. Existing request/head column grants stay
unchanged. Distinct ACK principal gains only state+ledger SELECT/schema USAGE,
no state INSERT/UPDATE/FOR UPDATE, heads/requests or clinical/checkpoint rights.
Existing suppression mutation rights remain separate. Recovery grant generation
must match this split; actual SQL denials and locks are native acceptance.

The actual consumed producer/ACK runtime uses common advisory fence before state,
head/request/suppression; ACK plain SELECT and database time/current authority are
read after waiting. The final executed head must retain and reverify those joined readiness/admission modules,
including current datastore/principal/ledger/forced-RLS checks. Earlier C-only captures contained schema
and fixtures only; assembled BC now contains runtime ancestry, while source recording clients do not prove cross-process fencing.
Native consumer plan from source560 names committed-intent-before-sink, repeated
output/new cycle, restart normal clear, uncertain process death/same UUID, ACK-only
clear after cold acquisition failure/current config, A/B isolation, SELECT-only
ACK state/RLS refusal and owned process exits. Root must bind these to final
actual Socket.IO/journey compatibility and recovery observations, with planted
lost-clear, regenerated retry and privilege-broadening controls. JSONB equality
review may still change runtime; recheck final source, schema and admissions.


## B3b9f review history and retained whole-C cohort requirements

B3b9f7c2eb4616b058c0bce67f47ccf93cf8d9efa/tree6cacbb3c6f487878c2d478b7607527805b6cb738
has distinct rt_checkpoint/eval_checkpoint namespaces and realtime/evaluator
principals. Its schema snapshots match C0a; C adds lifecycle schema. Candidate-only
projection, not a source merge, measures23files/21physical instances/37tables when
T/D/profile successors and both checkpoint instances are explicitly selected.
New bounded instances interface and config-bound seed helper preserve both.
Do not copy B bootstrap's broad ALL-table/ALL-sequence grants into recovery:
freeze its final actual-roleV2 matrix, then enumerate exact tables/columns/sequences
and each actual factory's separate readiness principal. C helper role names are
synthetic inputs, not a grant to combine capabilities.

Keep these cohorts distinct:

| Cohort | Exact setup and expected result |
|---|---|
| CURRENT full recovery | Final coherent B+C source;21instances/37tables, every table populated for both tenants, actual replay contract digests per checkpoint; exact snapshot/durable artifact/fresh restore/independent SQL and role denials. |
| Real schema-version upgrade | OLD a7f5cbf71ab9016855976fae74730727d0a78024/tree461b9a291e37372616101e1c9c6295a2b0d5e68c; T/D successors already current, profileBASE physically empty, all other OLD tables populated. OLD has18instances/31tables; NEW adds lifecycle0002, profile0002, fresh alarm/outbox/evaluator-checkpoint namespaces. Source artifact covers actual OLD only. Schema success is actual lifecycle0001→0002 with populated parent requests, not a synthetic/config-only migration. |
| Guarded populated predecessors | Separate populated profileBASE, outbox0001 heads-only and requests-only fixtures each refuse actual successor migration atomically. Empty counterpart succeeds. No invented natural order/private state backfill. |
| Configuration expansion | Adding separate evaluator checkpoint is a real namespace/configuration change. It supplements schema evidence, never replaces lifecycle version-upgrade evidence. |
| Deletion ceremony | CURRENT inventory and current trusted operator fixture authority; durable real artifact and held stopped-writer window, actual connections/barriers, no implicit confirmation or restored cancellation after committed start. |

The success-upgrade cohort deliberately has empty OLD profile and absent NEW
domains. It is not whole-populated upgrade across unsupported guards. OLD a7
source admission and its original operator binary must be independently archived,
not edited to understand NEW. Compare lifecycle0001 checksum byte-for-byte; capture
legacy requested/executed rows in the durable OLDartifact before any up. After NEW,
parent rows and all old projected columns remain exact, ceremony table exists and
legacy intent remains unconfirmed. Actual OLD checkRecord rejects NEW unknown/newer
inventory, actual migration check rejects lifecycle0002; rollback uses retained
artifact/record into fresh OLDnamespaces, never in-place down. NEWnamespaces and
postbackup writes remain untouched; rollback loss is explicit.

Native sequence: freeze joint source/dependency lock/actual-roleV2 manifest,
namespace-instance maps/current config/replay digests/outage contract/grant;
parent provisions exact owned loopback resources; inspect CURRENT physical seed
and role readiness before running core cases. Run durable capture/fresh restore,
refusal/interruption/rerun, actual lifecycle upgrade+OLD readiness/rollback,
guarded predecessor refusals, then deletion/races/retry. Use second operator raw
SQL snapshots before assertions; source summary routines are not the independent
oracle. Record each phase's config/head/resource birth/clock/statement category,
physical observations and predicted named refusal. An unexpected outcome stops
that phase and keeps all previous/failed captures. A repaired source needs a new
head/capture and re-review. Run planned mutations only in scratch archives, one
fault/family at a time; require assertion plus physical symptom, restore target,
then a complete final unmodified CURRENT/core sequence.

Controls must include omitted evaluator instance and namespace/role aliasing;
artifact/durability refusal before INSERT/GRANT/setval/up; self-consistent second
checkpoint tenant loss; identity ordinal/sequence loss; producer clear/retry loss;
COMMIT-for-ROLLBACK interruption; lifecycle confirmation/current-operator bypass;
cancel-after-durable-start; and actual privilege broadening. Do not count ordinary
setup/permission/timeout failures as semantic reds. Real barriers must show either
cancel commits with no claim, or claim commits and cancel refuses; destructive
rollback retains executing and permits same-artifact current-authorized retry.

Journey supplement consumes frozen clients.js descriptors and final actual
endpoints after fresh restore/OLDrollback, never Mongo-only launcher or synthetic
success responses. Compare headers/status/body/history/typed identity and actual
alarm/clear/retry handoff; classify unsupported/differences explicitly. Full-current
37table SQL fidelity and admitted runtime-compatible fixture data are separate:
placeholder policy/config/ciphertext fixtures do not make real consumer readiness.
Use real synthetic provider-owned keys/config identities for consumers; retain
same tenant/key material in fresh restore and test decryption/signing with existing
keys without exporting keys. Provider destruction/rotation is outside this plan.

Outstanding integration inputs, not new policy questions: final coherent source
join; physically validated exact actual-roleV2 manifest and selected readiness
factories; parent-approved operator/quiescence fixture adapter and pending outage
contract; review of the implemented full-populated native instrument. Historical
f77 two-domain instrument cannot be invoked unchanged as whole-C evidence. It owns
its containers itself; the new parent must enumerate full domains/instances, use
parent-owned resource identity and isolated configs. These inputs and the explicit
runtime grant must be concrete before any service action. No source test/census
or prepared plan promotes M5/M6/native acceptance.


## Executable SQL-core entry (source reviewed independently of native outcome)

`tools/lab/tenant-whole-c/{run.py,probe.js,core.js,oracle.js,observer.js,authority.js,window.js,writer.js}`
implements C1–C5. The parent archives exact committed NEW/OLD, validates private
lock-matched dependencies, parent container identity/owner/image/mount/endpoint,
actual role-manifest hash and explicit outage/grant inputs; it allocates no service.
A separate observer process uses read-only snapshots/raw pg_catalog/SELECT with no
backup encoder/summary. Actual restricted-role SQL and writer identity effects are
recorded before verdict. Parent control classifier requires an intended assertion
and designated physical symptom, targeted fresh restoration and final C1–C5.

Authority prototype uses actual operator-policy table and shipping advisory fence
on the supplied lifecycle transaction, with a clearly fixture-only typed actor
payload. It rereads SQL per admission; it does not call the existing store.read()
which owns another transaction. All fixture policy writes use the same fence.
Revocation changes an exported row and can stale an artifact; that fixture is a
terminal refusal, never a generation rollback workaround. Successful same-artifact
retry uses destructive rollback without changing authority or captured data.

The owned writer performs a real tenant-bound clock UPDATE using the actual API
principal, drains, then is independently observed SIGSTOPped by pid/start ticks/
uid/command hash. A live-writer check must refuse before the stopped window can
pass. This is SQL-fixture trusted operator quiescence, not serving ingress or a DB
fence. Exact child births are checked before cleanup signals. The parent retains
its fixture for independent teardown and does not report runtime RELEASED.

Eight prepared native controls have strict causal signatures and physical oracles;
none are native evidence until run. The full config contract and five-case
instrument are separate from staged journey descriptors. Mongo/Vault/actual API/
RT/evaluator/browser/current-token/IPC/provider behavior need separate composition
grant and runtime-ready synthetic configs, not SQL-fidelity fixtures.


Current lifecycle admission requires the **full exact selected catalogue ledger**
for export, artifact import and destructive admission. Unknown, stale, drifted or
reordered rows refuse; artifact/live agreement is not catalogue authority. A known
prefix requires an explicitly selected older inventory rather than current tables.
Identity-bearing tenant import is unsupported and refuses before any INSERT or
sequence effect. Same-ID TENANT restore remains OPEN: whole-deployment rollback can
revert foreign B and global API namespaces cannot transparently split A/B routing.
See `lib/tenant-lifecycle/IDENTITY-IMPORT-REVIEW.md` for the source-only maintenance
contract proposal and compatibility implications. No allocator workaround is enabled.
