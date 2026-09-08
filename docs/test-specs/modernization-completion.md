# Modernization completion evidence

This record closes the agreed M01–M30 automated work for the draft #8605
integration branch. It does not claim a shipped release or a manual production,
vendor-account, Atlas IAM or physical-device pass. The maintainer explicitly
owns those checks after automated completion.

## Comparison identity and scope

The original audit baseline is `9205ea300b9a6981ad8f16223c69620dd3c1c830`.
The final combined runtime contains #8717 (maintained cache), #8718 (database
rehearsal), #8719 (Flot/widget decision) and #8720 (Connect shutdown pin).
Raw [graph/image/bundle identities](../audits/final-modernization/graph-image-bundles.json)
record exact commits, lock/build hashes and runtime. Later report-test and
measurement-fixture changes do not change the measured production graph.
These are fresh combined comparisons, not sums of historical slice savings.

## Installation and images

| Metric | Baseline | Combined branch |
| --- | ---: | ---: |
| Production declarations | 65 | 37 |
| Development declarations | 20 | 24 |
| Locked package paths | 1,033 | 793 |
| Production-classified paths | 677 | 282 |
| Full installed file bytes (macOS) | 173,663,680 | 195,943,381 |
| Pruned installed file bytes (Linux image) | 101,704,501 | 64,135,556 |
| Runtime image bytes (uncompressed) | 279,203,413 | 239,443,787 |

Full development installation grows because test/build tools are measured too.
Filesystem counts exclude .cache/.bin and the hidden npm lock; they are file
lengths, not allocated disk space or RAM. Both images were freshly built with
`docker build --no-cache`, Node 22.23.2, Linux arm64, on the same Docker engine.
Observed single build durations were 36.58 and 18.00 seconds. Network/cache/order
and host scheduling affect these observations; no repeatable build-speed claim
or compressed-registry transfer claim is made. Hosted CI separately validates
native amd64 and arm64 images and real application startup.

Both [full](../audits/final-modernization/audit.json) and
[production](../audits/final-modernization/prod-audit.json) npm audits report zero
advisories on the final graph. Advisory absence is not proof of universal safety.

## Whole-server probes

Seven matched fresh processes per graph/configuration on each exact Node floor,
macOS arm64, owned empty MongoDB 8.0.29 database, production bundles, ten local
status requests and forced GC. Connect enabled uses an owned loopback source;
other remote providers are disabled. These are startup/short request workloads,
not representative patient-data or long-running production soak results.

| Node / Connect | Post-GC heap bytes, baseline → combined | Loaded modules | Startup median ms | Request median ms |
| --- | --- | --- | --- | --- |
| 22 / disabled | 45,571,056 → 26,387,688 | 1263 → 719 | 343.7 → 193.9 | 1.201 → 1.388 |
| 22 / enabled | 46,554,000 → 33,290,792 | 1263 → 817 | 372.2 → 257.9 | 1.456 → 1.418 |
| 24 / disabled | 46,687,184 → 27,232,264 | 1263 → 719 | 351.9 → 190.4 | 0.788 → 0.885 |
| 24 / enabled | 47,694,056 → 34,331,000 | 1263 → 817 | 364.0 → 260.4 | 0.836 → 0.955 |

Raw [Node 22](../audits/final-modernization/server-node22.json) and
[Node 24](../audits/final-modernization/server-node24.json) include every sample,
RSS, latency, active resource and listener count. Short request latency does not
improve consistently; no throughput claim is made. Earlier owned provider,
notification-cache and connector cycle/retainer probes explain scoped ownership
changes; their savings must not be added to this measured total. Shutdown tests
prove that connector-owned listeners and pending output waits are released;
already-issued database writes are not cancelled.

## Browser transfer and workload

The baseline serves a single application bundle to the five application pages.
The combined branch shares a narrower dashboard bundle plus page entries.
Measured with the same Node 22 zlib and gzip level 9:

| Bundle | Baseline gzip bytes | Combined gzip bytes |
| --- | ---: | ---: |
| app | 496,510 | 305,212 |
| reports | part of app | 56,591 |
| admin | part of app | 7,926 |
| profile | part of app | 6,834 |
| food | part of app | 5,316 |
| clock | 61,784 | 62,703 |

The five application entries total 381,879 gzip bytes; clock is standalone and
excluded from that sum. Each specialized page loads app plus its own entry.
Clock grows slightly; no universal per-entry reduction is claimed.

Seven paired cold-start samples per page (Chromium 153, 576 glucose records,
48 treatments, 300 foods, one profile) pass the existing startup/heap limits.
Seven paired service-worker journeys visit all five pages then revisit each;
cached revisits make zero bundle requests. Median completed response body bytes
fall from 1,651,030 to 1,359,001 and non-polling requests from 203 to 178.
[Startup](../audits/final-modernization/browser-startup.json) and
[journey](../audits/final-modernization/browser-journey.json) evidence includes
raw timing, DOM, heap, transfer and build identities. Timings vary by page;
the dashboard median is slightly higher within the matched variation limit.
These historical measurements used the then-current fixture query-credential
option. The security follow-up removes that option: measurement browser contexts
now send the fixed fixture credential in a header, so the unchanged baseline can
still authenticate. Production authentication is untouched; the original raw
measurements/source hashes remain a record of their original implementation.

## Validation and handoff

Final local validation passed on actual Node 22.23.2 and 24.20.0: 2,120 backend
cases (one existing pending), 283 client-core, 305 dependency and 87 installed
connector cases per floor. Lint has zero errors and 16 existing warnings. Clean
installs/production builds and both pruned npm-start/config-import/routes/assets
checks passed, including Unicode SCRAM success and wrong-password rejection.
Node 24 development and production rebuilds passed; backend cases exercise HMR
contracts. Hosted checks cover all retained Node/Mongo combinations, replica
failover, current Chromium/Firefox/WebKit, npm 12, CodeQL and both image arches.
The database job upgrades owned MongoDB 5→6→7→8 volumes and verifies fresh-volume
restores of original and final backups through authenticated Nightscout APIs.
Current-head hosted results and exact merge-tree/artifact verification must pass
before the final child merges. #8605's final merge is checked against fresh dev.

M22 now preserves proxy compatibility by default after the Kubernetes production trial; direct-only and explicit proxy trust remain opt-in. See the
[configuration guide](../proposals/trusted-proxy-migration.md). M25 retains the
bounded profile reference cache and uses maintained notification caching with
explicit clone/expiry semantics. Notification keys remain TTL-bound rather than
silently evicting live acknowledgements. M27 retains narrowed Moment; M28 retains
selected jQuery UI/jQuery and upgrades Flot after characterization. These are
completed decisions with review triggers, not unfinished compulsory rewrites.

Maintainer handoff: verify the edge-managed proxy boundary or configure optional explicit trust, and verify runtimes; run the branch in
the intended production environment; validate vendor accounts/Atlas IAM where
used, upgrade/rollback with a known-good artifact and backup, and physical devices
including Safari/VoiceOver. No extra MongoDB retirement or automatic dev merge is
authorized. Keep #8605 draft and #8328 open through that handoff/integration.

Rollback uses the known-good deployment artifact and its runtime/configuration;
follow the database backup recovery guide rather than running older MongoDB
binaries against an upgraded data directory. Preserve authentication/storage,
profile/therapy and notification behavior checks when rolling back.

## Reproduction

Use isolated installed/built baseline and candidate worktrees, the same exact
Node executable, a disposable MongoDB fixture database and fresh output paths.
Run CPU/heap probes sequentially on an otherwise idle host. Never substitute a
production URI for the owned fixture.

```sh
npm ci
npm audit --json
npm audit --omit=dev --json
node tools/measure-installed-files.js
node tools/measure-page-bundles.js
python3 tools/audits/connect-server-probes.py /path/to/baseline . /tmp/new-server-evidence \
  --node /path/to/node --mongo-uri mongodb://127.0.0.1:27017/owned_fixture --port 17349
node tools/measure-page-startup.js /path/to/baseline 7 all
node tools/measure-page-journey.js /path/to/baseline 7
docker build --no-cache --progress=plain -t nightscout-owned-comparison .
docker image inspect nightscout-owned-comparison
```

Keep each image/lock/build identity alongside the raw output. The complete
build/install procedure, workload and limits are versioned in the linked tools;
changing gzip implementations can change byte counts, so use the recorded Node
zlib when comparing historical bundle measurements.
