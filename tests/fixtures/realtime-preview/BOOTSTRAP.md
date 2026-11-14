# Parent-owned joined runtime bootstrap

Source preparation only. PostgreSQL/Mongo/Vault setup, real credentials, actual
role readiness and joined runtime acceptance are UNMEASURED until the coordinator
freezes the joined controller/source and grants one owned campaign.

`bootstrap.js` exports:

```js
const prepared = await bootstrap({sourceDir, captureDir, env, resources, onObservation});
const phase = await prepared.resetForPhase(phaseId);
// phase = {configuration, roleEnvironments, phaseEnvironment}
// Parent writes reference-only role env descriptors and ownership/config files,
// invokes the actual phase driver, and drains every role before the next reset.
await prepared.close();
```

`prepared` also provides phaseConfigurations, the in-memory roleEnvironments and
phaseEnvironment, ownership, and activePhase. The exact phase IDs are
joined-role-recovery, joined-data-parity, joined-consumer-handoff,
joined-consumer-plugin-ack, joined-socket-epoch and joined-browser-consumer. The parent supplies sourceHead, ownershipFile and each
role's env-reference filename (apiEnvFile, evaluatorEnvFile, realtimeEnvFile and ownerEnvFile) in phase configuration. It may set
profileUncertaintyResolved only after the actual profile campaign establishes it;
bootstrap leaves it false. No helper readiness or profile completion is inferred.

Required private environment values:

- NS_TEST_POSTGRES_ADMIN_URI, CUSTOMCONNSTR_mongo,
  NS_RT_BOOTSTRAP_VAULT_ADDRESS, NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN;
- NS_RT_BOOTSTRAP_OPTIONS_JSON with exact positive integer fields: timeoutMs,
  recoveryIntervalMs, timeIntervalMs, pollIntervalMs, retryIntervalMs,
  retryDelayMs, attemptTimeoutMs, maxRows, maxBytes, pageSize, maxMessageBytes,
  maxPayloadBytes, maxConnections, maxInflight, snoozeMs, settleMs,
  observationMs, credentialLifetimeSeconds;
- NS_RT_BOOTSTRAP_UI_JSON: bundleDirectory, expectedBundleSha256 and public settings;
- NS_RT_BOOTSTRAP_NATIVE=1 only during a coordinator-authorized actual bootstrap;
- NS_RT_BOOTSTRAP_PGSTREAM_BINARY: absolute nonsymlink executable path, and
  NS_RT_BOOTSTRAP_PGSTREAM_SHA256: the exact core evaluator binary pin;
- distinct explicit loopback service ports NS_RT_BOOTSTRAP_PGSTREAM_RECEIVER_PORT
  and NS_RT_BOOTSTRAP_PGSTREAM_SUBSCRIPTIONS_PORT;
- NS_RT_BOOTSTRAP_PGSTREAM_BINDING_JSON: exact canonical deployment binding
  descriptor {file,repository,commit,sha256,configSha256}. The helper checks
  pgstream.js and its sibling config.js against both the descriptor and git show
  at that commit before importing them. There is no download or legacy fallback.

The coordinator supplies NS_MULTITENANT_PGSTREAM_POSTGRES_IMAGE as the qualified
PostgreSQL 16.16 image with wal2json identified by early.plan.pins.postgres and
starts it with the required logical replication capabilities. The supplied
isolated database must have no pgstream schema, selected slot or stream login.
The shared pgstream-native helper delegates DBA initialization and subscription
wiring to that pinned canonical deployment binding using the actual core routes.
It returns the private generated NS_RT_BOOTSTRAP_PGSTREAM_CONFIG path. The actual
evaluator CLI owns the maintained producer process and receiver. Capability
absence refuses preparation; no synthetic notification or output substitutes.

Timer bounds fit Node timers; timeoutMs fits the actual Vault provider's bound;
credentialLifetimeSeconds cannot exceed the actual local credential lifetime limit.
Optional evaluatorMaxRows/realtimeMaxRows choose distinct clinical row bounds; each
defaults to explicit common maxRows. pageSize must fit both chosen values. Initial
per-tenant synthetic baseline has one clinical row, so the lower evaluator bound
must admit that actual baseline. A cold test declares entryCount exceeding the
evaluator bound while total actual realtime data still fits the realtime bound.
Set these limits before initial API/evaluator boot; changing infrastructure after
the linked API starts correctly requires restart. Parent coldAcquisition contains
evaluatorConfigFile, observerFile, revision and entryCount. The evaluator file is
returned and attested in ownership.configurationFiles. Parent owns the explicit
actual CLI observer preload/env/path; bootstrap never invents a health result.
The cold test increments the actual committed settings version after closing the warm evaluator; it restores settings with another monotone version. The immutable configuration file is not rewritten.
There are no inferred capacity, retry or retention defaults. Bounds must also pass
the actual API/evaluator/realtime configuration parsers.

Resources must include exactly one postgres, mongo and vault record with parent
attested containerId, exact pinned image digest from early.plan, owner label,
mounts and explicit loopback host/port (PG database too). Handed URLs must match.
The PostgreSQL database must be explicitly disposable (`test` in its name), as in
the existing actual labs. The fourth record is private-directory, with path, mode
0700 and ownerUid. The parent creates and owns this short directory and all phase
capture directories; bootstrap never removes them. No container or product role listener is started by this adapter. The explicit canonical DBA initializer runs the pinned producer init command before role startup.

Bootstrap creates only random uniquely prefixed fixture schemas, distinct
restricted login roles plus the separately owned replication login and one unique Vault transit mount/policies/tokens. It
refuses existing own-name namespaces/databases rather than adopting them. Reviewed
BASE catalogues plus treatments/devicestatus/profile successors, clock, separate
typed RT/evaluator checkpoints, registry, committed settings/operator policy, lifecycle/activity, authorization/access/legacy/secrets, alarm suppression
and notification0001+0002 are installed through the actual migration runner.
Grant SQL is explicit in bootstrap-grants.js. The evaluator reads clinical tables and writes completed output. Realtime reads only completed output and trusted metadata, with a separate typed receipt schema; actual denial checks require raw clinical SELECT and INSERT to fail. The outbox worker cannot write clinical/checkpoint state;
the ACK connection can SELECT producer state but cannot INSERT/UPDATE it. Actual
production readiness still decides whether these grants are safe; native privilege
acceptance has not run.

Original tenant API_SECRET material is encrypted using actual createSecrets,
createVaultTransit and restricted PostgreSQL persistence. A bootstrap-only operator
capability authorizes that preparation; it is not a client authorization claim.
The API role Vault token can decrypt admitted tenant data and HMAC/verify admitted signing keys. Separate bootstrap signing tokens create local access credentials. Local machine credentials are
actually Vault-signed when bootstrap executes. Current credentials and scoped
service URLs stay only in returned memory/environment maps. Config documents
contain public settings, public keys, datastore descriptor and environment
reference names; no password/token/plaintext secret is written to a config file.
The realtime map contains neither Vault nor signing/decryption authority.

The selected API link uses the same evaluator file through metadata-only loading.
Optional worker datastore{hostname,port,database} binds the actual resolved worker
URI; existing worker checks bind outbox/suppression to the same endpoint and prove
actual selected connections during startup. A selected API link requires that
nonsecret descriptor and compares its own admitted ACK endpoint. Metadata loading
validates reviewed names/settings/bounds/refnames without resolving or returning
worker credentials/socket capabilities. The API and evaluator derive current tenant identities from the same committed registry and effective settings. The API receives only its own serving/readiness/ACK URLs,
not evaluator/outbox/suppression credentials. Unselected/default worker credential
resolution remains strict and descriptor is otherwise optional.

Before each phase, resetForPhase requires the parent to have drained all prior
children. It clears/reseeds only fixture-owned tables and the owned Mongo database,
using a common actual database epoch for synthetic rows/floors. A/B have equal
settings identities and different readings. The consumer phase starts with a low
alarm; other phases start with a normal reading. Independent physical clinical,
checkpoint, suppression and producer-state rows are passed to awaited
onObservation before returning the phase. No reset occurs inside a phase.

Actual treatmentnotify is enabled so an actual manual treatment can exercise
plugin snooze through the API. Its shipping default window is retained: the
selected environment refuses unsupported treatmentnotify extended settings.
Parent snoozeMs is human ACK duration, not a plugin override. The current consumer
driver alone does not establish active-plugin ignored-ACK or cold-failure clear;
those actual sequences must be added/measured by the joined consumer owner.

Browser configuration uses named one.example.test and two.example.test aliases,
with browserHost and browserResolverHosts for explicit Chromium loopback mapping.
The actual product rejects numeric-IP aliases (reproduced TENANT_HOST_INVALID);
there is no product hostname relaxation or io.connect patch. The parent browser
owner supplies the actual same-head bundle and named-host resolver configuration.

All four actual roles (API, evaluator, realtime and tenant-admin) join the same operation cohort through separately restricted lifetime identities and real private endpoints. Synthetic direct clinical mutations use the exported product clock writer in the same transaction; typed completion must precede protected-frame assertions. Public API/socket, privilege, authorization, clinical and restore gates remain actual runtime requirements.

close drains only this adapter's database handles and removes successfully owned
schemas/roles/Mongo database/Vault tokens/policies/mount, the owned inactive replication slot and producer schema, and private plaintext producer wire files. It refuses an active slot until the parent drains the evaluator child. It never stops parent
containers, role children, ingress or directories. Observations expose synthetic
rows and object names, never credentials. Error messages contain only safe codes
and setup step; no raw provider body, connection URI or SQL password is published.
