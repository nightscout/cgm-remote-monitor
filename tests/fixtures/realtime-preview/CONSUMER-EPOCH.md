# Joined consumer and socket epoch fixture contract

Source-only fixture preparation. These are explicit parent-owned CLI campaign phases,
not generic tier/corpus wrappers. No native result is claimed by the source checks.
Use `early.js --execute <phase> <captureDir>` with the existing reviewed root observer,
owned endpoint/bootstrap and exact source-head/hash capture. No fixture provisions services.

## joined-socket-epoch

Uses the actual API and RT CLI roles and unchanged Socket.IO clients. The trusted
`beforeRealtime` fixture hook publishes an owned private relay for only `/authorize`
and `/mutate`; all original Host, tenant and credentials reach the actual API. It
holds a genuine successful old authorization response, then reauthorizes the SAME
socket to an actual valid status-only actor before releasing the response. Main and
alarm protected payloads must remain absent. A separate barrier disables the actual
shared operator admission row before releasing an already-authorized main response;
no stale frame may escape. No fake rights response, stale credential cache or client
wire extension is used.

Required joined config: `epochReadCredentialEnv`, `epochStatusCredentialEnv`,
`epochObservationMs` (explicit positive <=30000), existing tenant/host/timeout/alarm
endpoint/message bound. The read actor must grant aggregate read and the status actor
must authenticate but deny aggregate read in both namespaces. API optional display
reader must be unselected for the config-guard control: status is false and a missing
config guard must expose a stale frame rather than fail accidentally in display code.
`owned.configurationFiles` attests the mutable shared admission file. The fixture
restores its exact bytes only while dev/ino/UID match.

Raw `actual-socket-epoch.json` records actual API hold/release, per-vector payloads,
actual RT handoff response, operator restoration and cleanup. Each barrier must be
exercised or the phase fails. Controlled joined source variants: remove the protocol
`epoch` refusal -> old main/alarm payload assertion red; remove `frameFor` current
configuration refusal -> operator-tightening payload assertion red. Positive and
ablations remain UNMEASURED until root grants actual services.

## joined-consumer-handoff

Actual successful evaluator output -> durable request COMMIT -> actual RT alarm
handoff. One owned relay response is lost AFTER actual handoff; retry must retain UUID
and payload. Revoked first recipient receives nothing while the valid recipient gets
the alarm. Receipt remains null: acceptance is server handoff, not device delivery.

Required additional joined config: `dataCredentialEnv` is a current actual main
socket writer credential, and `coldAcquisition` contains
`{evaluatorConfigFile,observerFile,revision,entryCount}`. The config file is attested by
`owned.configurationFiles`; the observer lives in a parent-owned 0700 directory.
Parent supplies separate explicit evaluator/RT maxRows so actual API-added entryCount
exceeds the evaluator limit while total RT current rows remain within the RT limit.
No product limit or policy changes. A warm CLI is stopped, only the owned selected
tenant config revision is changed, and the actual cold CLI restarts. The observer
must show its new PID, actual `EVALUATOR_ACQUISITION_REFUSED`, and last=null BEFORE
human ACK. Actual authorized API ACK must commit suppression and cause accepted
persisted clear plus actual `clear_alarm` while the cold clinical result remains null.
Original config bytes are restored after roles close with inode/UID checks.

The evaluator child V1 environment explicitly selects ONLY the reviewed preload:
`NODE_OPTIONS=--require=<readonly archive>/tests/fixtures/realtime-preview/observe-evaluator.js`,
`NS_RT_EVALUATOR_OBSERVE=1`, `NS_RT_EVALUATOR_OBSERVATION_FILE`, explicit positive
`NS_RT_EVALUATOR_OBSERVATION_INTERVAL_MS` and `NS_RT_EVALUATOR_OBSERVATION_MAX_BYTES`,
`NS_RT_SOURCE_HEAD`, and `NS_RT_NATIVE_PHASE`. These are parent-selected references,
never client or ambient input. The preload calls actual boot with identical options,
reads actual health/last getters, records only tags/null with PID/head/preload+product
hashes to a bounded private file, and delegates close. No result/config/auth mutation,
mock result or extra listener. Evidence is actual CLI with disclosed observation,
not an uninstrumented binary claim.

Raw `actual-consumer-handoff.json` accumulates accepted requests, relay attempts,
physical ACK/suppression rows, cold API packets/physical rows and before/after actual
CLI observations; cleanup never overwrites those fields. Source controls at final
joined campaign: retry with fresh request UUID -> same-ID oracle red; bypass current
socket rights -> stale recipient oracle red; omit selected control-only producer
clear -> cold clear oracle red. Native results remain UNMEASURED here.

## joined-consumer-plugin-ack

Separate fresh service/data cohort in the same parent campaign, so normal ACKs do
not contaminate plugin state. Enable actual treatmentnotify, using its actual default
10-minute snooze; do not invent an extended-settings override. An actual main API
Note treatment is stored before starting the real evaluator. Require committed private
producer default-group level2/level1 windows with silenceTime=600000 and fresh owner
suppression. An actual authorized `/alarm` human ACK during that window must preserve
both original private windows/absolute expiry and leave owner suppression unchanged,
immediately and after the explicit bounded observation interval. No private-state
insertion, fake clock or ten-minute wait. Raw `actual-plugin-ack.json` records real
API packet/reply/physical treatment, committed state before/after, owner suppression
and cleanup. Required config uses existing namespaces/consumerId/alarmcredentialEnv,
`dataCredentialEnv`, `snoozeMs`, `observationMs`. Ablate selected ACK plugin-window
admission -> owner-write/window oracle red. Native results remain UNMEASURED here.
