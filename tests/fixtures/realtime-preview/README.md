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
polling/websocket-selected native transport and actual Mongo reference, capturing
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
