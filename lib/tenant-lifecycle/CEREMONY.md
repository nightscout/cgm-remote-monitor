# Preview deletion ceremony and execution boundary

Source-only implementation of the adopted explicit request + operator confirmation,
cancellation until execution starts, and no mandatory pre-deletion wait. Native
transaction/privilege/claim-race acceptance remains UNMEASURED. Post-deletion
30-day key/artifact retention is a separate contract; no key destruction or
automatic artifact/tombstone expiry is implemented.

## Capability composition

Obtain the complete selected inventory through deployment admission, including
pinned alarm/outbox extensions. Compose the returned tenant lifecycle instance:

```js
const controlled = admission.lifecycle.withCapabilities({
  authorize: trustedCurrentAuthority,
  verifyDurableArtifact: lifecycle.createFilesystemArtifactVerifier({ directory }),
  executionWindow: trustedQuiescentOperatorWindow
});
```

`authorize({ connection, tenant, requestId, action })` must use current authority
in the same transaction, including any authority-row locks needed to retain that
snapshot until COMMIT. It returns `{ allowed: true, current: true, tenant, plane,
principal, consumer }`; all fields are checked. Request/cancellation may use a
currently permitted owner/operator actor. Confirmation, claim and execution
REQUIRE the separate operator plane even when an owner callback says allowed.
Options supplied to an owner route cannot impersonate that trusted capability.
Current authority is checked again immediately before destructive effects.

The durable verifier reloads the complete tenant artifact from private immutable
filesystem storage, verifies its digest, rows and ciphertext/key references, and
binds it to the original tenant/request. `saveTenantArtifact` uses exclusive 0600
files, file/directory fsync, verified staging, atomic publication and a verified
reload. No plaintext secret/provider key is fetched or returned. Missing/corrupt
storage refuses before claim/destruction. No memory-only success fallback exists.

The execution-window capability must report the exact tenant as current and
quiesced. The operator/controller must hold that stopped-writer window across
claim and destructive transaction; the library rechecks it at both admissions.
This is a controlled preview/fixture precondition, NOT D15 all-credential blackout,
not a PostgreSQL writer fence and not an inference from access_tenants.active.
No production quiescence adapter is selected. Native fixtures own/control their
writers and must separately exercise late-write refusal; production lifecycle
remains a separate integration boundary.

A raw lifecycle object without full admission refuses destructive operations.
`withCapabilities` preserves the census/selected catalogues and does not permit
an injected capability object to replace them. Current candidate changes are
re-censused before destructive admission; unreviewed/missing M5 tables cannot be
silently omitted. Tenant export/import retains the same-ID binding; clone/new-ID
credentials or cryptographic remapping are outside this interface.

## State transitions and cancellation cutoff

Migration0001 remains unchanged. Append-only0002 adds a composite request/tenant
key and forced-RLS `tenant_lifecycle_ceremony`, with actor/time/confirmation/claim
metadata and state constraints. The parent request row and ceremony row are locked
in the same order by confirmation, cancellation and claim.

| State/action | Observable result |
|---|---|
| Request | Ledger + requested ceremony commit together; no deletion. Owner intent never executes. |
| Confirm | Current operator + durable artifact; requested becomes confirmed. Repeated confirmation retains its original time. |
| Cancel before start | Current authorized actor locks the same request; requested/confirmed becomes cancelled. Execution can never win afterward. |
| Start execution | Current operator + durable artifact + quiescent window + full current row/key fidelity; confirmed becomes executing with a claim UUID. Successful COMMIT is the cancellation cutoff. |
| Cancel after start | Refuses EXECUTION_STARTED, including after destructive rollback or process interruption. |
| Execute | Reuses/creates the durable claim, opens a fresh transaction, rechecks all prerequisites and current operator authority, deletes tenant data in reverse dependency order, and marks both request/ceremony executed atomically. |
| Interrupted destructive transaction | All deletions/final markers roll back. The already committed executing claim remains; cancellation is not reopened. A current-authorized operator may retry only the same request/artifact/claim. |
| Source/artifact changes after claim | Refuses without deletion; claim remains executing for explicit operator recovery. No automatic artifact rebind, restart of cancellation, abandon or destructive workaround. |

There is no waiting timer. Confirmation/start/execution can share the request
instant; clock rewinds behind a persisted confirmation/start refuse.
The lower-port `transaction` requires a fresh transaction and acknowledges COMMIT;
calling inside an outer transaction is not allowed to pretend the claim committed.
Callbacks must not wrap the whole protocol in one uncommitted outer transaction.

Legacy requested rows have no implicit confirmation. After migration they may
obtain a lazy requested ceremony row under the same parent lock, then require
explicit operator confirmation and full current-artifact checks. A legacy artifact
that omits newly admitted domains refuses; use an explicitly reviewed new request/
artifact rather than silently upgrading its meaning. Historical executed rows
remain executed. The original request/ceremony ledgers are retained independently
of deleted tenant rows and are included in whole-deployment backup/restore.

## Privilege and secret boundary

Owner request/cancel rights never confer clinical DELETE, operator confirmation,
claim or execution. Final native role inputs must enumerate request/ceremony
column grants: owner request fields only, cancellation fields only; operator
confirmation fields and separate start/finalization effects as explicitly reviewed.
The shared parent `SELECT FOR UPDATE` requires an UPDATE privilege. The owner
request/cancel backend receives only `UPDATE(phase)` on that parent, never
`executed_at`; the original paired-state CHECK prevents phase alone from marking
the request executed. Owner request INSERT lists only request/tenant/digest/phase/
requested-at columns. Ceremony INSERT lists request/tenant/phase/requested actor
columns; cancellation UPDATE lists phase/cancelled actor/time columns. Confirmation,
claim/start and finalization columns remain operator-only. These are backend
capabilities, not raw SQL credentials returned to an owner client. Native checks
must prove both the row lock and forbidden state/clinical effects under these
precise grants.

Do not grant blanket table UPDATE, DELETE, TRUNCATE, DDL, BYPASSRLS or elevated
membership. Schema/ledger SELECT is limited to the actual selected principal.
Check actual allowed/denied SQL and row effects under both tenants, not metadata
inspection alone. Request IDs/claim IDs are identifiers, not bearer authority.

Neither confirmation nor failure returns credential material. The export retains
ciphertext/recovery references; provider/key retention/destruction is not selected
or invoked by this code.

## Verification and native plan

Source recording-client tests cover operator/current-authority/confirmation guards,
no wait, durable-file tamper, missing window/admission, old ledger/legacy intent,
interruption/retry, late writes and both cancellation/claim orderings. The test
transaction queue models serialization; it is NOT a PostgreSQL concurrency proof.
Auth hooks used in unit tests are synthetic fixtures, not an accepted production
operator adapter. Meaningful planted bypasses must fail, then restored source pass.

At the coherent C native boundary, apply actual0001 then0002 to populated history;
verify old migration checksum unchanged; provision exact current owner/operator
roles/capabilities; persist/reload real artifacts. Use separate real connections
and barriers to race cancellation versus claim in both orderings. Independently
observe the committed start before any DELETE, kill/interrupt after that boundary,
verify rollback retains executing and cancellation refuses, then retry with current
operator authority and the same artifact. Revoke authority between confirm/claim/
execute; lose/corrupt storage or the stopped-writer window; inject a late write;
require named refusal, no unauthorized SQL/effect, foreign preservation and exact
cleanup. Test duplicate execution and cross-tenant request/claim use. Run one final
unmodified whole populated capability suite after the source-control family.
Root owns that grant, final B merge/census and comprehensive acceptance.

Journey-map client/consumer tests and probes should supplement the final native
run with single-tenant/multitenant behavior comparisons, including recovery and
deleted-tenant refusal. This source package does not claim that comparison ran.


Current lifecycle admission requires the **full exact selected catalogue ledger**
for export, artifact import and destructive admission. Unknown, stale, drifted or
reordered rows refuse; artifact/live agreement is not catalogue authority. A known
prefix requires an explicitly selected older inventory rather than current tables.
Identity-bearing tenant import is unsupported and refuses before any INSERT or
sequence effect. Same-ID TENANT restore remains OPEN: whole-deployment rollback can
revert foreign B and global API namespaces cannot transparently split A/B routing.
See `lib/tenant-lifecycle/IDENTITY-IMPORT-REVIEW.md` for the source-only maintenance
contract proposal and compatibility implications. No allocator workaround is enabled.


Physical relation admission: within every explicitly selected owned namespace,
lifecycle export/import/destructive preflight and deployment backup/restore/summary
now compare live `pg_class` metadata against the exact reviewed ordinary tables plus
the ordinary `schema_migrations` ledger. Agreement of ledgers alone is insufficient.
Unlisted ordinary/partitioned/foreign/materialized/view relations refuse; listed
partition parents/children or nonordinary relation kinds are unsupported. No unknown
relation is adopted, read for data, exported, dropped or granted permissions by the
guard. Indexes and sequences are not independent dataset entries in this guard;
known identity allocator contracts remain separate. There is no explicit allowance
for unlisted tenant tables in the selected namespace contract.

This is a read-only snapshot/transaction guard, not a namespace DDL fence. The
private operator must coordinate a stable no-DDL window with privileged migration/
maintenance jobs; restricted serving roles already lack schema DDL. Concurrent
privileged DDL exclusion has not been proved by this metadata query. Configured
37-table census is not a measurement of the database until live admission passes.
Same-ID identity tenant restore remains unsupported; this check does not close it.


Ordinary inheritance is also unsupported. A selected ordinary relation can have
parents or descendants in another namespace while remaining `relkind=r` and not
a partition. Admission therefore checks both `pg_inherits.inhrelid` and
`inhparent` for each selected relation, including the migration ledger, and refuses
any participation. It does not adopt foreign descendants or substitute `ONLY` to
silently narrow the operation. This remains metadata-only point-in-time admission,
not a concurrent privileged-DDL fence. The configured 37-table selection and
same-ID tenant-restore gap retain their prior scope.


Execute, confirm, cancel and claim acquire current authority (including the
same-transaction policy fence) before the parent request and ceremony locks.
Execution retains later current-authority checks before destructive effects. A
source concurrency control using the actual ceremony and SQL authority adapter
reproduces a policy/request cycle when only the first execute authority check is
removed; its SOURCE_MODEL_DEADLOCK is a controlled model result, not PostgreSQL
40P01. Restoring the check removes that cycle and preserves the durable claim
across destructive rollback.

The same C5 fixture prepares an already committed executing claim, holds the
parent request on an independent connection, and starts execute/cancel in both
orders. Raw pg_stat_activity barriers and blocker graphs precede verdicts. The
expected deliberate destructive interruption rolls back every row; cancellation
refuses because execution has started. The native lock-order ablation must expose
actual 40P01 with both contention barriers. Setup failure, timeout, or source-model
cycles cannot qualify. Native execution of this expanded control is UNMEASURED.
