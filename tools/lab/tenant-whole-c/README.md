# Whole-C PostgreSQL fixture

This fixture checks schema migration and tenant lifecycle operations against an
explicitly selected and owned local PostgreSQL database.

| Case | Scope |
| --- | --- |
| C3 | Migrate the reviewed OLD catalogues to NEW, compare retained data and observe transactional rollback on interruption. |
| C4 | Check that the old binary refuses the new ledger and record. Exercise populated and empty migration guards. |
| C5 | Observe tenant-scoped export, authority, writer quiescence, deletion, retry and foreign-tenant preservation. |

Whole-deployment database recovery belongs to the platform operator. Cases C1 and
C2 exercised the retired application backup format. Retained historical results
describe the source and cohorts identified in each capture.

## Required parent config and grant

Pass `--old-deps` with the dependency tree matching the OLD source lock when it differs from the current lock.
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

## Independent observations

C5 owns three real SQL writer births across its success/late-write/revocation
fixtures. Each writer actually updates its tenant clock with the API principal,
drains its connection, and is SIGSTOPped. Window checks compare pid/start ticks/uid/
command digest and actual process state; live or reused identities refuse. This
is trusted operator SQL-fixture quiescence, not a database writer fence, D15 blackout
or evidence that serving ingress is stopped. No API/RT/evaluator is started here.
