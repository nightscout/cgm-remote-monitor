# Whole-C PostgreSQL core instrument

Prepared source; **all native cases/controls UNMEASURED until granted execution**.
This is the assembled B+C instrument, not the historical f77 two-domain lab.
No serving role imports it. It creates no container, pulls no image, installs no
dependency and changes no defaults. Root owns the exclusive slot and parent PG.

Source check (no services, connections or runtime config required):

```bash
python3 tools/lab/tenant-whole-c/run.py --check
```

The entry archives a clean committed head plus exact OLD a7, verifies both package
locks against the existing private dependency copy, and uses `NODE_PATH` without
symlinks/install/write to that copy. Exact source, control patches, stdout/stderr,
raw observations, process identities, cleanup and hashes are retained. A mismatch
stops dependent stages; failed attempts stay immutable. An unmodified all-case invocation reserves at most214schemas and creates108roles
(three C5 writer births plus probe/observer =5Node births); all stages comprise
22invocations on the same explicitly parent-owned PG resource. Cleanup is checked
after every invocation. These are fixture bounds, not capacity measurements.
Ten causal controls in
`controls.json` must produce the named assertion **and** physical symptom; setup,
permission, timeout or parser failures do not qualify. Each restored target gets a
fresh fixture namespace/role cohort; final unmodified C1–C5 is mandatory.

| Case | Expected measurement |
|---|---|
| C1 | CURRENT21instances/37tables populated for both tenants, durable verified closed-handle reload, fresh restore with explicit ACL, separate raw observer equality, actual role denials and next identity INSERT. |
| C2 | Tampered artifact/durability boundaries refuse before writes; partial restore interruption rolls back rows/grants; fresh rerun matches. Sequence effects are observed, never claimed transactional. |
| C3 | Exact OLD a7/18instances31tables, T/D already successors, profile deliberately empty, NEW domains absent. Actual lifecycle0001→0002 with populated legacy requests, durable OLD artifact before NEW, real NEW ledger/table and OLD-column preservation. Scoped event trigger interrupts unchanged actual lifecycle ALTER transaction; physical rows/columns/constraints/ledger remain atomic, artifact retained. |
| C4 | Actual OLD binary rejects NEW record/ledger; fresh OLD rollback preserves NEW forensic state and records post-backup loss. Separate profile-populated, heads-only and requests-only guards refuse atomically; empty controls succeed. |
| C5 | Real current SQL authority/fence, durable tenant artifact, actual restricted writer drain/SIGSTOP proof, two real connection lock barriers and one race winner, independently observed committed start, destructive rollback/no reopened cancel/same-artifact retry, foreign preservation, late-write and revoked-authority refusal. |

C3 deliberately has empty OLD profile and absent NEW domains. It is not a claim of
whole-populated migration across the guarded profile/outbox predecessors. C1 is
the separate fully populated CURRENT recovery cohort. Adding a checkpoint instance
is a configuration expansion, not the schema-upgrade criterion.

## Required parent config and grant

Use a new private output directory. Runtime config must match `config.js`; there
are no automatic runtime defaults for the parent fixture, role rights or outage.
The config contains:

- `version:1`, exact `sourceHead`, `oldHead` (a7), and parent-extracted `oldRoot`;
  the parent fills immutable source markers and overrides per-invocation paths.
- `captureDirectory`, `prefix` (`wc_` plus twelve hex), `adminEnv` naming the
  environment-only admin URI, and `expectedEndpoint:{host:'127.0.0.1',port,database}`
  for the owned test database. The URI never goes into capture/config/logs.
- `grant`, matching the explicit root runtime-grant reference, and
  `outageContract:{status:'approved-by-root',reference}`. A pending contract refuses.
- `parentResource:{containerId,image,labelKey,owner,volumes,database}`. Parent
  verifies real Docker ID/image/owner label/loopback port/mount identities and records
  only sanitized fields. It never saves Docker Config.Env.
- `actualRoleManifestPath`, `actualRoleManifestSha256`, `acl`: the physically
  reviewed manifest's exact `grants` array mapped to C kinds, including
  `checkpoint`→actual RT checkpoint and `evaluator_checkpoint`→actual evaluator
  checkpoint. Raw B namespace aliases are refused, not silently discarded.
  Role fields are exact classes `api/readiness/alarm/realtime/evaluator/suppression/
  outbox`; rights enumerate each named table/column/sequence, including the
  actual separate readiness principal. No bootstrap ALL grants are copied.

The instrument remaps role classes to fresh per-cohort NOBYPASSRLS login principals
and adds explicit separate fixture `lifecycle_operator/lifecycle_owner` rights.
Operator has tenant-bound full-inventory read/delete plus required ceremony effects;
owner has request/cancel columns and current policy SELECT, no clinical DELETE or
confirmation/start/final columns. Both use the existing policy fence before current
SQL authority reads on the same transaction. The fixture actor payload is not a
production authentication/management policy. No actor option in an owner request
can supply the trusted callback.

The SQL-core checkpoint digests, opaque ciphertext and policy fixtures prove SQL
fidelity only; they do not claim consumer readiness or real provider-key recovery.
Actual readiness/IPC/current-token/journey runs need the root composition's real
synthetic configs, credentials and provider-owned keys in their separate scope.

Once root supplies the concrete reviewed inputs and slot:

```bash
python3 tools/lab/tenant-whole-c/run.py \
  --worktree "$FROZEN_JOINED_SOURCE" --deps "$PRIVATE_NODE_MODULES" \
  --config "$PRIVATE_RUNTIME_CONFIG" --out "$NEW_CAPTURE_DIRECTORY" \
  --grant "$ROOT_RUNTIME_GRANT" --stages all
```

`--stages initial|controls|final` supports a root-approved stopped-run continuation;
it does not waive the final unmodified run. Source repair requires a new head and
capture. `--timeout` bounds each child (default600seconds); it is not the human
outage contract. C4 target controls also execute the real C3 precondition and label
those observations; the top-level selected result remains C4.

## Observer and cleanup

The raw observer runs separately, owns a read-only repeatable-read snapshot and
reads only exact reserved prefix namespaces. Its code imports no artifact encoder,
summary, lifecycle or migration reader. It records rows including generated fields,
columns, ledgers, constraints, policies and sequence state before assertions.
Clinical write-denial probes specify identity values explicitly, so missing sequence
USAGE cannot masquerade as missing INSERT. Next-value probes separately use the
actual API writer/default identity path. Parent requires designated raw physical
symptoms and exact restored results; a green planted fault is a mismatch to report.

C5 owns three real SQL writer births across its success/late-write/revocation
fixtures. Each writer actually updates its tenant clock with the API principal,
drains its connection, and is SIGSTOPped. Window checks compare pid/start ticks/uid/
command digest and actual process state; live or reused identities refuse. This
is trusted operator SQL-fixture quiescence, not a database writer fence, D15 blackout
or evidence that serving ingress is stopped. No API/RT/evaluator is started here.

Only absent-at-start reserved schemas and freshly created roles are removed.
Signals require exact recorded owned births; source process groups and child audits
are captured by the parent. Cleanup failure prevents acceptance. The parent's PG
container/volumes are deliberately retained and independently identity-checked;
the parent must tear them down and certify resource release. `runtimeReleased`
stays false in this instrument's closure. Unknown baseline resources are preserved.

The journey map descriptors are staged separately in the existing capability
index. No Mongo/Vault/browser/mobile/provider resource is implicitly allocated by
SQL-core commands. The lane hands root raw captures, all failures/repairs, source
and manifest hashes, exact scope, unmeasured gaps and final cleanup evidence before
broader Batch C acceptance.


Current lifecycle admission requires the **full exact selected catalogue ledger**
for export, artifact import and destructive admission. Unknown, stale, drifted or
reordered rows refuse; artifact/live agreement is not catalogue authority. A known
prefix requires an explicitly selected older inventory rather than current tables.
Identity-bearing tenant import is unsupported and refuses before any INSERT or
sequence effect. Same-ID TENANT restore remains OPEN: whole-deployment rollback can
revert foreign B and global API namespaces cannot transparently split A/B routing.
See `lib/tenant-lifecycle/IDENTITY-IMPORT-REVIEW.md` for the source-only maintenance
contract proposal and compatibility implications. No allocator workaround is enabled.


C5 additionally stages an unknown clinical ledger with matching poisoned artifact
and an owned omitted table; actual export and erase must refuse before any clinical
effect. It then tests identity-import prewrite refusal, unchanged foreign rows and
sequence counters, and the actual selected entries v3 write-intent allocator after
refusal (not completed restore). Fixture seeding initializes counters only while
all namespaces are newly created/private and no allocator session exists; that is
not a tenant import algorithm.

Optional `allocatorResearch:"private-cache-counterexample-v1"` is a separately
reviewed C5 research input. It stages one absent-at-start private sequence and two
owned operator SQL sessions, demonstrates why raising a counter cannot invalidate
a retained session's CACHE8 block, then closes both and removes only that sequence.
It does not touch application sequences, grant new rights or implement tenant
restoration. Omission keeps this research disabled; no new service is allocated.
All new native observations remain UNMEASURED until root grants the core batch.


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


C5 uses the same owned hidden-table witness in three sequential, independently
observed states: known full ledger plus hidden table; unknown ledger with otherwise
exact physical relations; and combined unknown ledger plus hidden table. The
physical-guard and ledger-guard mutations target the first and second states
respectively, so a different guard's refusal is not misgraded as the intended
unsafe effect. The independent observer records actual namespace relation names,
kinds and partition flags before verdict, as well as the hidden synthetic rows.
The drift guard covers deployment backup too. No new service cohort is allocated.


Ordinary inheritance is also unsupported. A selected ordinary relation can have
parents or descendants in another namespace while remaining `relkind=r` and not
a partition. Admission therefore checks both `pg_inherits.inhrelid` and
`inhparent` for each selected relation, including the migration ledger, and refuses
any participation. It does not adopt foreign descendants or substitute `ONLY` to
silently narrow the operation. This remains metadata-only point-in-time admission,
not a concurrent privileged-DDL fence. The configured 37-table selection and
same-ID tenant-restore gap retain their prior scope.


C5 stages ordinary inheritance in one additional registered private namespace
within the existing cohort: an outside child adds a descendant-only column and
synthetic A/B rows. The manually prepared structural artifact contains parent
projection fields only; actual export/backup/erase must refuse participation.
The observer records raw inheritance edges and descendant columns before verdict.
Removing only the inheritance predicate must expose accepted projection/omitted
extra field and actual descendant-A deletion with foreign B unchanged. Other
relation/ledger controls retain the inheritance predicate so an earlier guard does
not mask their own causal witness. The fixture then removes only its owned child
and namespace. No extra service, role or Node birth; maximum registered namespaces
becomes214 and ten control pairs make22total invocations.

The optional private CACHE8/two-session research probe remains in this SAME C5
cohort, disabled by omission and separately reviewable. It changes no application
allocator/grant and proves no tenant-restoration availability contract. Physical
observations are separate from acceptance. All inheritance/cache native outcomes
remain UNMEASURED.

Source mechanisms are documented in the [PostgreSQL16 inheritance manual](https://www.postgresql.org/docs/16/ddl-inherit.html)
and [CREATE TABLE inheritance/identity description](https://www.postgresql.org/docs/16/sql-createtable.html).
These support the predicted semantics; they are not a substitute for native results.
