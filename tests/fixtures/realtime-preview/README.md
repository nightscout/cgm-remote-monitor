# Root-owned joined native adapters

`node tests/fixtures/realtime-preview/early.js --plan` opens no resources.
Actual execution requires a root runtime grant, `NS_RT_EARLY_NATIVE=1`, explicit
phase and capture. This adapter never starts/pulls/removes containers.

The callable interface is `execute({sourceDir,captureDir,phaseId,control:null,env})`.
An immutable source archive contains product and fixtures; parent independently
pins source/files/resource identity and begins birth observation before services.
Native Mocha inventory proposal: `tests/realtime-preview.native.test.js`, enabled
only with `NS_RT_NATIVE_PHASE`, `NS_RT_NATIVE_CAPTURE` and explicit early flag.
No shared inventory was edited.

- `uds-ownership`: generated unique0700 capture child; file/symlink/socket refuse,
  post-link replacement startup failure, actual request/normalclose, replacement
  inode close. Record dev/ino/UID/mode/internal path, exact owned cleanup. Requires
  short absolute capture path (<=65bytes). Linux hardlink publication measured;
  serviceUID trust only, no malicious sameUID/processID/production guarantee.
- `profile-port-differential`: actual canonical executor/handler + actual PG socket
  profile port versus immutable same-head Mongo canonical reference. Explicit
  synthetic preauthorized actor ONLY, no current auth/transport acceptance. Three
  cases, raw callback/physical rows captured before assert, stopfirstmismatch.
  Requires NS_RT_PROFILE_CONFIG, NS_RT_SOURCE_HEAD, NS_TEST_POSTGRES_ADMIN_URI,
  CUSTOMCONNSTR_mongo, NS_RT_PROFILE_WRITER_URI. Parent provisions reviewed profile
  catalogue, restricted NOSUPER/NOBYPASS writer and ledgerSELECT/profileCRUD.
- `profile-differential`: same packets/effects through actual private API UDS;
  requires root-owned actual API+Vault in addition. No direct-port substitute.
- `joined-role-recovery`: starts actual separate API/RT CLI children from handed-in
  root configs, owned local HTTP ingress. Polling+websocket initial frame, quiet
  physical deletion with unchanged clock, independent backstop/reconnect absence,
  current grant tightening, natural child shutdown. Not executed in preparation.

Profile private JSON: version1, sourceHead, phaseId, ownershipFile, tenant,
profileNamespace, mongoDatabase (`rt_profile_` +16–32hex), timeoutMs,
maxMessageBytes; direct phase additionally authorityBoundary exactly
`synthetic-preauthorized-canonical-port-only`. PrivateAPI phase additionally host,
apiSocketPath, credentialEnv (original socket credential JSON in env). Ownership
file repeats sourceHead/phaseId/tenant/profileNamespace/mongoDatabase and resources
{kind,image(actualsha256ID),containerId,labelKey,labelValue,mounts,host,port,database}.
ActualAPI ownership adds api{pid,sourceHead,socketPath}. Parent independently
checks live ownership before and after; adapter validates received constraints.

Joined phase also requires NS_RT_JOINED_NATIVE=1 and NS_RT_JOINED_CONFIG JSON:
version1/sourceHead/ownershipFile/apiEnvFile/realtimeEnvFile/timeoutMs/observationMs,
tenant/host/credentialEnv/entriesNamespace/clockNamespace/authorizationNamespace/
subjectId/syntheticMgdl. Ownership must name same namespaces/tenant. Each role env
JSON explicitly binds loopback and its PORT string"0"; real bound ports parsed
from actual CLI logs. RT env must omit Vault/sign/decrypt/root-secret authority.
Root ensures actual admission + role config aliases resolve requested host.

Optional joined uiFixture has bundleDirectory, expectedBundleSha256 and settings.
It serves actual unchanged views/index.html, actual production app bundle and
static startup/client assets in CONTROLLED reference ingress. No build occurs;
root supplies frozen same-head artifact/hash after its approved build. Socket
paths route to actual RT; tenant API goes actual API. API remains headless: this
is not a production UI mount. No io.connect override, alternateRTport browser JS,
new client wire, production TLS/trustedforwardedscheme or Android binary claim.

Remaining joined consumer acceptance is OPEN: root actual browser driver, all6
DATA parity after profile characterization, current alarm/sparsefailedrecipient/
outbox producer-retry path, SQL denied-RTwrites, close/config-epoch and destructive
source controls require the final root composition/instrument join. These helpers
and role recovery are a prepared slice, never a comprehensive completion claim.
Profile/role/API/Vault/Mongo phases have NOT run in this lane. Only the explicitly
granted bounded generated local UDS ownership experiments ran.

`joined-data-parity` additionally consumes root-owned CUSTOMCONNSTR_mongo,
config.mongoDatabase (`rt_data_`+randomhex) matching ownership.mongoDatabase,
config.namespaces matching ownership.namespaces, and explicit
profileUncertaintyResolved:true (root evidence prerequisite, never inferred).
It runs all six actual dbAdd+same stableidentity retry packets through realRT
websocket transport (role recovery separately tests polling) and actual Mongo reference, capturing
raw replies/noack and independent typed physical rows before assertions. Noack
parity is recorded as baseline refusal, never synthesized success; expected
canonical duplicate logs remain in parent capture. This phase has not executed.
Role-recovery now consumes real RT SQL six-table INSERT-denial probes with
rollback and exact42501 oracles; no grants are modified. Root fullcampaign still
owns callback COMMIT/outage/restart/config controls and outbox-coordinator join.

Browser native proposal: tests/browser/realtime-preview.native.test.js with
existing real-browser hooks, NS_RT_JOINED_BROWSER=1 + NS_RT_JOINED_NATIVE=1 and
root config. Supply browserHost127.0.0.1 admitted alias, browserCredentialEnv
(original subject opaque token), alarmSocketPath,maxMessageBytes and current
clinical settings permitting urgent alarms. It serves unchanged actual page and
startup assets via controlled fixture, observes same-origin actual socket paths,
actual browser receiveddata SGV replacement and urgent DOM path; no monkeypatch
of io.connect, no production UI mount or device audio delivery promise. This test
is source prepared only. Root supplies built same-head bundle/hash at campaign.

Full consumed-outbox proposal: `tests/realtime-consumer.native.test.js` requires
NS_RT_CONSUMER_NATIVE=1 + NS_RT_JOINED_NATIVE=1 on the ROOT final consumer source.
Role config additionally has evaluatorEnvFile (actual final evaluator consumers
config), outboxNamespace/consumerId, staleCredentialEnv/staleSubjectId,
alarmNamespace,snoozeMs,settleMs,observationMs,maxMessageBytes,alarmSocketPath.
Root ownership attests outbox/auth/alarm namespaces and synthetic subjects. Short
captureDir<=56bytes permits a generated0700 fixed-/alarm-only UDS relay. It forwards
to actual RT, intentionally loses ONE response after actual handoff, then permits
same-ID retry. This is an explicit test instrument, not a production genericproxy.
The actual evaluator coordinator (timers/current output) creates durable intents;
fixture never calls a detached enqueue helper or substitutes currentauth. Real
first stale /alarm subject has its owned grants removed; valid second subscriber
must receive. Independent outbox rows/attemptIDs/payloads precede assertions.
Actual socket ACK persists suppression, level2→1, and stops further alarm delivery
after configured settle. Cleared/normal residual-state acceptance must join final
notification owner's approved transition semantics; this fixture does not invent
cancellation or device receipts. Only serverhand off/nullreceipt is asserted.
Fixture restores removed owned grants, closes actual CLI children producer first,
then exact owned relay and driver. NONE of this broader consumer phase has run.

Read-only setup preflight:
`node tests/fixtures/realtime-preview/early.js --validate-config profile-port-differential`
validates private JSON/handed-in ownership metadata/source identity without
connecting to PG/Mongo/Vault or starting listeners. CLI exports its plan before
configuration reads it. Restoring exports-after-CLI is a calibrated source setup
control (undefined plan/pins, exit1); repaired validation exits0. This is fixture
loading evidence, never backend natural-order evidence. Failed original native
setup remains UNMEASURED; no alternate-invocation sidestep.

Role-recovery requires foreignTenant/foreignHost/foreignCredentialEnv/
foreignSyntheticMgdl and ownership.foreignTenant too. Actual polling/websocket
A/B frames must contain only their synthetic tenant values; A quiet deletion
must preserve B current output. These are required native isolation oracles,
not optional singletenant fallback. Root seeds matching current fixtures.
