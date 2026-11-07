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
phaseEnvironment, ownership, and activePhase. Four exact phase IDs are
joined-role-recovery, joined-data-parity, joined-consumer-handoff and
joined-browser-consumer. The parent supplies sourceHead, ownershipFile and each
role's env-reference filename in phase configuration. It may set
profileUncertaintyResolved only after the actual profile campaign establishes it;
bootstrap leaves it false. No helper readiness or profile completion is inferred.

Required private environment values:

- NS_TEST_POSTGRES_ADMIN_URI, CUSTOMCONNSTR_mongo,
  NS_RT_BOOTSTRAP_VAULT_ADDRESS, NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN;
- NS_RT_BOOTSTRAP_OPTIONS_JSON with exact positive integer fields: timeoutMs,
  recoveryIntervalMs, timeIntervalMs, pollIntervalMs, retryIntervalMs,
  retryDelayMs, attemptTimeoutMs, maxRows, maxBytes, pageSize, maxMessageBytes,
  maxPayloadBytes, maxConnections, maxInflight, maxSockets, snoozeMs, settleMs,
  observationMs, credentialLifetimeSeconds;
- NS_RT_BOOTSTRAP_UI_JSON: bundleDirectory, expectedBundleSha256 and public settings;
- NS_RT_BOOTSTRAP_NATIVE=1 only during a coordinator-authorized actual bootstrap.

Timer bounds fit Node timers; timeoutMs fits the actual Vault provider's bound;
credentialLifetimeSeconds cannot exceed the actual local credential lifetime limit.
There are no inferred capacity, retry or retention defaults. Bounds must also pass
the actual API/evaluator/realtime configuration parsers.

Resources must include exactly one postgres, mongo and vault record with parent
attested containerId, exact pinned image digest from early.plan, owner label,
mounts and explicit loopback host/port (PG database too). Handed URLs must match.
The PostgreSQL database must be explicitly disposable (`test` in its name), as in
the existing actual labs. The fourth record is private-directory, with path, mode
0700 and ownerUid. The parent creates and owns this short directory and all phase
capture directories; bootstrap never removes them. No container/process/listener
is started, found, retried or replaced by this adapter.

Bootstrap creates only random uniquely prefixed fixture schemas, seven distinct
restricted login roles and one unique Vault transit mount/policies/tokens. It
refuses existing own-name namespaces/databases rather than adopting them. Reviewed
BASE catalogues plus treatments/devicestatus/profile successors, clock, separate
RT/evaluator checkpoints, authorization/access/legacy/secrets, alarm suppression
and notification0001+0002 are installed through the actual migration runner.
Grant SQL is explicit in bootstrap-grants.js. Clinical readers have separate
checkpoint schemas. The outbox worker cannot write clinical/checkpoint state;
the ACK connection can SELECT producer state but cannot INSERT/UPDATE it. Actual
production readiness still decides whether these grants are safe; native privilege
acceptance has not run.

Original tenant API_SECRET material is encrypted using actual createSecrets,
createVaultTransit and restricted PostgreSQL persistence. A bootstrap-only operator
capability authorizes that preparation; it is not a client authorization claim.
Scoped API Vault tokens can decrypt their own tenant data, HMAC/verify their own
signing key and sign their own local access key. Local machine credentials are
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
worker credentials/socket capabilities. Tenant identity hashes are identical to
the full worker parser. The API receives only its own serving/readiness/ACK URLs,
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

close drains only this adapter's database handles and removes successfully owned
schemas/roles/Mongo database/Vault tokens/policies/mount. It never stops parent
containers, role children, ingress or directories. Observations expose synthetic
rows and object names, never credentials. Error messages contain only safe codes
and setup step; no raw provider body, connection URI or SQL password is published.
