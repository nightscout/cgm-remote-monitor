# The multitenant test corpus

Contributor-facing. The multitenant preview's suites are opt-in: each stays
registered as pending in the `integration` tier until an environment flag, a
PostgreSQL admin URI, a MongoDB URI or a Vault address enables it, so the
default tiers and the Mongo-only CI jobs never execute them. One command runs
the corpus with disposable services:

```bash
npm run test:multitenant                       # every suite below
npm run test:multitenant -- --list             # the inventory, as the script holds it
npm run test:multitenant -- --only subject-admin --only vault   # paths containing either text
npm run test:multitenant -- --record run.json  # also write the run record (ids, counts, status)
```

`scripts/test-multitenant.js` holds the inventory as data and refuses to run
when a test file calls `optInSuite` with an `NS_` flag or reads
`NS_TEST_POSTGRES_ADMIN_URI` without being listed, so a new opt-in suite is
added there and in the table below.

## What the command does

- Starts, on random loopback ports with credentials generated per run and passed
  only through the child's environment:
  - one PostgreSQL 16 (`postgres:16`), creating and selecting
    `nightscout_multitenant_test` through `POSTGRES_DB`, when a selected suite reads
    `NS_TEST_POSTGRES_ADMIN_URI`, unless the caller has already set that
    variable (the script then opens a session on it first and stops with exit 2 if
    it cannot). The explicit test database satisfies the clock-port fixture's
    disposable-database safety check; the guard and caller-provided URI are
    unchanged;
  - one MongoDB (`mongo:8.0`) when a selected suite opens `CUSTOMCONNSTR_mongo`,
    unless the caller has set it. The variable is removed from the child
    environment otherwise: `tests/ci.test.env` points it at
    `127.0.0.1:27017`, and nothing in this run may reach a database the caller
    did not name;
  - one Vault dev server (the digest the suites pin) when a selected suite reads a
    Vault address from the environment; it is always disposable.
- Sets `TZ=UTC` in the child environment, as every CI job does, so a
  zone-dependent suite fails the same way on a developer machine as in CI.
- Sets the selected suites' flags, then runs their files through mocha the way
  `scripts/test-tiers.js` runs the `integration` tier: `--fail-zero`, the
  execution reporter, `tests/hooks.js`, `--exit`, the tier's 15 s default
  timeout (every suite in the corpus sets its own, 30 s to 120 s, which overrides
  it), with the values of `tests/ci.test.env` except as above. The tier's first
  and last files (the shared-database safety gate and clean-up) are left out:
  they guard a database the operator owns, and this run owns its databases.
- Removes exactly the containers and anonymous volumes it created, by recorded
  id (`docker rm --force --volumes`), then verifies each is absent. Containers
  carry the label `ns.multitenant.run=<run id>` so a leak after a hard kill can be
  found with `docker ps -a --filter label=ns.multitenant.run`.
- Exits 0 only when mocha passed and at least one test passed; 1 on a failing
  test, zero passing tests, or a container or volume still present after
  teardown; 2 on a usage, inventory, Docker or provisioning error. `--only`
  matching nothing is exit 2 before anything starts.

Images can be overridden with `NS_MULTITENANT_POSTGRES_IMAGE`,
`NS_MULTITENANT_MONGO_IMAGE` and `NS_MULTITENANT_VAULT_IMAGE`. MongoDB 8.0
refuses to start on Linux 6.19 to 7.0.13 (SERVER-121912); the CI job runs on
`ubuntu-22.04` for that reason, and three suites below start `mongo:8.0.34`
themselves.

## Inventory

39 suites. 21 use the admin URI the script provides; 22 start at least one
container of their own through Docker. Disabled, 38 register their
tests as pending with `[pending opt-in: <requirement>]` in the title; one
(`postgres-entries-write`) uses a bare `describe.skip`.

| Suite | Flag(s) the script sets | Script provides | Starts its own | Note |
|---|---|---|---|---|
| `tests/postgres-connection.test.js` | admin URI only | PostgreSQL | | |
| `tests/entries-importer-postgres.integration.test.js` | admin URI plus `NS_POPULATED_RECOVERY_DOCKER_TEST=1` | PostgreSQL | PostgreSQL source and fresh restore target | populated stopped-write snapshot/ledger/typed identity reference; no key recovery |
| `tests/postgres-entries-read.test.js` | admin URI only | PostgreSQL, MongoDB | | |
| `tests/postgres-entries-write.test.js` | admin URI only | PostgreSQL, MongoDB | | `describe.skip`, silent when disabled |
| `tests/api3.entries-crud.http.test.js` | `NS_ENTRIES_CRUD_HTTP_TEST=1` | PostgreSQL, MongoDB | | |
| `tests/tenant-rest-entries.integration.test.js` | `NS_ENTRIES_CRUD_HTTP_TEST=1` | PostgreSQL, MongoDB | | |
| `tests/tenant-rest-identifier-race.integration.test.js` | `NS_ENTRIES_CRUD_HTTP_TEST=1` | PostgreSQL, MongoDB | | |
| `tests/tenant-rest-identity-differential.integration.test.js` | `NS_ENTRIES_CRUD_HTTP_TEST=1` | PostgreSQL, MongoDB | | |
| `tests/tenant-frame-concurrency.integration.test.js` | `NS_ENTRIES_CRUD_HTTP_TEST=1` | PostgreSQL, MongoDB | | |
| `tests/tenant-durable-replay.integration.test.js` | `NS_TENANT_DURABLE_REPLAY_TEST=1` | PostgreSQL | | dormant current-state consumer; producer SIGKILL/snapshot/RLS/rollback |
| `tests/tenant-projection-evaluator.integration.test.js` | `NS_TENANT_PROJECTION_EVALUATOR_TEST=1` | PostgreSQL | | dormant recovered projection to actual clinical views; fresh-table/restart/tenant/failure checks |
| `tests/tenant-commit-clock-port.integration.test.js` | `NS_TENANT_COMMIT_CLOCK_TEST=1` | PostgreSQL | | |
| `tests/tenant-commit-clock-http.integration.test.js` | `NS_TENANT_COMMIT_CLOCK_HTTP_DOCKER_TEST=1` | | PostgreSQL, Vault | functional cases enabled; benchmark separately opt-in |
| `tests/multitenant-preview-replicas.integration.test.js` | `NS_MULTITENANT_PREVIEW_REPLICAS_DOCKER_TEST=1` | | PostgreSQL, Vault | independent CLI processes on one host |
| `tests/tenant-rest-derived.integration.test.js` | `NS_REST_DERIVED_HTTP_TEST=1` | PostgreSQL, MongoDB | | |
| `tests/tenant-rest-treatments.integration.test.js` | `NS_REST_TREATMENTS_HTTP_TEST=1` | PostgreSQL, MongoDB | | |
| `tests/tenant-rest-context.integration.test.js` | `NS_REST_CONTEXT_HTTP_TEST=1` | PostgreSQL, MongoDB | Vault | |
| `tests/tenant-rest-device-activity.integration.test.js` | `NS_REST_DEVICE_ACTIVITY_TEST=1` | PostgreSQL, MongoDB | Vault | its Vault is `hashicorp/vault:latest`, unpinned |
| `tests/tenant-rest-profile-food.integration.test.js` | `NS_PROFILE_FOOD_HTTP_TEST=1` | PostgreSQL, MongoDB, Vault (`NS_PROFILE_FOOD_VAULT_ADDRESS`/`_TOKEN`) | | mounts transit at the fixed path `transit`: one run per Vault |
| `tests/tenant-rest-settings-differential.integration.test.js` | `NS_SETTINGS_DIFFERENTIAL_TEST=1` | PostgreSQL, MongoDB, Vault (`NS_SETTINGS_VAULT_ADDRESS`/`_TOKEN`) | | |
| `tests/postgres-migrations.integration.test.js` | `NS_MIGRATION_DOCKER_TEST=1` | | PostgreSQL | |
| `tests/mongodb-migrations.integration.test.js` | `NS_MIGRATION_MONGO_DOCKER_TEST=1` | | MongoDB | `mongo:8.0.34` replica set |
| `tests/postgres-secrets.integration.test.js` | `NS_SECRETS_POSTGRES_DOCKER_TEST=1`, `NS_VAULT_DOCKER_TEST=1` | | PostgreSQL, Vault | the second flag enables its one backup-restore case, which starts raft Vaults |
| `tests/vault-secrets.integration.test.js` | `NS_VAULT_DOCKER_TEST=1` | | Vault | |
| `tests/tenant-runtime-vault.integration.test.js` | `NS_TENANT_RUNTIME_VAULT_DOCKER_TEST=1` | | PostgreSQL, Vault | |
| `tests/tenant-entries-http.integration.test.js` | `NS_TENANT_HTTP_DOCKER_TEST=1` | | PostgreSQL | |
| `tests/tenant-socket-data-forwarding.integration.test.js` | `NS_SOCKET_DATA_FORWARDING_TEST=1` | PostgreSQL, MongoDB | | real sockets and canonical forwarded PG DATA writes; pinned AAPS pattern replay, not binary |
| `tests/tenant-socket-order-capability.integration.test.js` | `NS_SOCKET_ORDER_CAPABILITY_TEST=1` | PostgreSQL | | prototype optional successor: old/new ledger matrix, populated refusal, fresh insertion order |
| `tests/tenant-credential-http.integration.test.js` | `NS_TENANT_CREDENTIAL_HTTP_DOCKER_TEST=1` | MongoDB | PostgreSQL | its differential cases open `CUSTOMCONNSTR_mongo` |
| `tests/tenant-authorization-postgres.integration.test.js` | `NS_TENANT_AUTHORITY_POSTGRES_DOCKER_TEST=1` | | PostgreSQL | |
| `tests/owner-preview.integration.test.js` | `NS_OWNER_PREVIEW_TEST=1` | PostgreSQL | PostgreSQL, Vault | explicit headless owner CLI and real combined data/owner listeners; provisioned machine tokens/current state, no human session promises |
| `tests/subject-management-http.integration.test.js` | `NS_SUBJECT_MANAGEMENT_HTTP_DOCKER_TEST=1` | | PostgreSQL | |
| `tests/subject-admin-postgres.integration.test.js` | `NS_SUBJECT_ADMIN_POSTGRES_DOCKER_TEST=1` | | PostgreSQL | |
| `tests/owner-subject-policy.integration.test.js` | `NS_OWNER_SUBJECT_POLICY_DOCKER_TEST=1` | | PostgreSQL | verifies its own volume removal |
| `tests/tenant-rest-authority-review.test.js` | `NS_REST_AUTHORITY_REVIEW_TEST=1` | | PostgreSQL | |
| `tests/storage-port-contract.integration.test.js` | `NS_STORAGE_PORT_CONTRACT_DOCKER_TEST=1` | | PostgreSQL, MongoDB | `mongo:7.0` |
| `tests/tenant-frame-acquisition.integration.test.js` | `NS_FRAME_ACQUISITION_TEST=1` | | PostgreSQL, MongoDB | `mongo:8.0.34` |
| `tests/tenant-rest-client-replay.integration.test.js` | `NS_REST_CLIENT_REPLAY_TEST=1` | | PostgreSQL, Vault | spawns the shipping CLI as a child |
| `tests/multitenant-preview-process.integration.test.js` | `NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST=1` | | PostgreSQL, Vault | spawns the shipping CLI as a child |

Not opt-in suites, although their names suggest it: `NS_TEST_BACKEND` selects
the storage backend for a whole run (`tests/support/backends.js`, tested by
`tests/test-backends.test.js` in the `harness` tier), and
`NS_TEST_MIGRATION_OPTIONS` carries options to a child process inside
`postgres-migrations`.

Every suite in the table runs under the one command; none is held out. The
whole-corpus run is a batch-slot measurement, not a property of this page.

The HTTP clock suite's performance benchmark stays pending unless the caller
explicitly sets `NS_TENANT_COMMIT_CLOCK_BENCHMARK=1`. Its functional cases run by
default with the corpus. One pending benchmark is therefore expected in a default
whole-corpus run; it is not a skipped functional suite or performance acceptance.
The runner reports pending counts and requires passing tests with no Mocha
failure; it does not require zero pending tests. Do not reuse a pre-clock run's
passing count or zero-pending prediction for this expanded inventory.

## CI

The `multitenant-postgres` job in `.github/workflows/main.yml` runs
`npm run test:multitenant` on the newest Node line, on `ubuntu-22.04`, with no
service containers: 22 suites start their own containers through Docker
whatever the job provides, so the script starting the shared PostgreSQL, MongoDB
and Vault the same way is the simpler arrangement. The job is one of the
`Tests pass` aggregate's dependencies.


## Populated PostgreSQL recovery reference

The existing importer integration file also registers seven owned-container cases
behind `NS_POPULATED_RECOVERY_DOCKER_TEST=1`. The default enabled corpus sets this
flag; no extra benchmark or pending-as-pass is added. For a focused reference:

```bash
NODE_ENV=test TZ=UTC NS_POPULATED_RECOVERY_DOCKER_TEST=1 \
  node node_modules/mocha/bin/mocha.js --fail-zero --exit --timeout 120000 \
  tests/entries-importer-postgres.integration.test.js --grep 'populated PostgreSQL'
```

This source-prepared lab uses the actual operator migration runner and existing
review-candidate entries catalogue, actual identity codec and string-only API
importer. It stops writers before `pg_dump --format=custom` and restores into a
fresh target using `pg_restore --single-transaction --exit-on-error`. Independent
populated tenant/kind/document and ledger oracles, restricted read-only migration
checking, truncated/schema-only snapshots, typed-kind corruption, paired RLS break,
failed dump selection and importer interruption/rerun are exercised by the cases.
The lab uses two specifically owned loopback-only PostgreSQL16 containers with
tmpfs data directories, random credentials and private0700/0600 scratch files;
teardown checks labels/mount identity and verifies owned resource absence.

**Source prepared; database execution UNMEASURED.** The catalogue remains a review
candidate; this is not deployment/schema certification or a production backup tool.
Dump ownership/ACLs are deliberately excluded and separate restricted application
privileges are recreated in the target; no production privilege fidelity claim.
No Vault/provider key recovery, live-write snapshot, Mongo snapshot, operational
activation/deletion, numeric budget or full M6 acceptance follows from this lab.
