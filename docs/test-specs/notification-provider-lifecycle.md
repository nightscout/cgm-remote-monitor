# Optional notification provider loading and cleanup

M04 defers `@parse/node-apn` until Loop has validated configuration, profile and notification payload, and defers `pushover-notifications` until its token and recipients are configured. Dependencies remain installed. Configured provider APIs, payloads, retry/receipt choices and transport error behavior are preserved.

APN previously created a new provider for each send without closing it. Each real client starts an unreferenced heartbeat interval that retains the client. The updated path closes the provider after success, failed responses and rejected sends, and closes it before rethrowing a synchronous send error. Invalid payloads no longer create a provider. Notification compilation happens before provider construction.

## Regression coverage

- `tests/apn-lifecycle.test.js`: disabled initialization, missing/invalid configuration and payloads, repeated success/failure/synchronous errors, payload expiry and token fields, and real APN client heartbeat cleanup over two sends. The real-provider test compiles actual notifications and mocks only client delivery; it fails against the old source because the client remains alive. It explicitly verifies `isDestroyed` and cleared heartbeat intervals.
- `tests/pushover-lifecycle.test.js`: absent/invalid configuration without imports, recipient selection and receipts, disabled alarm recipients, send errors, cancellation success/failure and two independent setup/call cycles. Five disabled-import cases fail against the parent.
- Existing Loop, Pushover, push-notification and API v2 privacy/permission tests remain required. The combined focused set passes 79 tests. All transports use fixture credentials/mocks; no real notification is sent.

On the current integration parent, the clean locked installation/production build and full Node 22.23.2 suite pass **2,008 tests with three existing pending**. Client-core passes 283 and dependency compatibility 317; final GitHub checks remain required before merging.

## Matched whole-server measurements

Parent `756fca7c` versus candidate runtime sources `c7fe0213`, macOS arm64, Node 22.23.2, MongoDB 6.0.27, clean identical lockfiles and production builds. Seven fresh processes per revision/configuration use an isolated empty database, ten status requests and forced GC. In the enabled configuration, both real provider modules load: 20 APN notifications are compiled with an ephemeral fixture key and mocked client delivery; Pushover initializes with fixture settings and completes 20 mocked sends. This is a controlled startup/send fixture, not a representative patient workload or live-provider soak test.

| Configuration / metric | Parent median (range) | Updated median (range) |
| --- | --- | --- |
| Disabled providers: post-GC heap bytes | 41,113,368 (41,102,168–41,125,032) | 37,356,200 (37,356,056–37,361,232) |
| Disabled providers: RSS bytes | 149,831,680 (149,471,232–151,617,536) | 140,722,176 (140,148,736–141,557,760) |
| Disabled providers: loaded modules | 1,168 | 1,032 |
| Both enabled: post-GC heap bytes | 41,470,504 (41,470,216–41,470,792) | 41,415,736 (41,414,704–41,419,496) |
| Both enabled: RSS bytes | 150,519,808 (150,011,904–150,847,488) | 145,801,216 (145,211,392–147,570,688) |
| Both enabled: loaded modules | 1,168 | 1,168 |
| APN clients retained after 20 sends and GC | 20 | 0 |

Disabled post-GC heap decreases by 3,757,168 bytes (about 3.58 MiB), with 136 fewer loaded modules. Enabled heap decreases by 54,768 bytes in this short fixture; the repeated-send client retention fix is the significant lifecycle result. RSS medians differ by 8.69 MiB disabled and 4.5 MiB enabled, but allocator/platform behavior makes those figures less portable than the heap/retainer evidence. No installed-package saving is claimed.

Observed event-listener counts and referenced resource counts are unchanged. Startup medians are 330/305 ms disabled and 335/331 ms enabled. Status-request latency medians are 0.94/1.03 ms disabled and 0.96/1.13 ms enabled; per-process median ranges overlap (0.84–1.14/0.79–1.34 ms disabled, 0.87–1.26/0.85–1.20 ms enabled). These short local timings do not establish a throughput or latency improvement.

Reproduce using disposable checkouts/databases only:

```sh
python3 tools/audits/notification-provider-probes.py \
  /absolute/parent-checkout /absolute/current-checkout /absolute/output-directory \
  --node /absolute/node \
  --mongo-uri mongodb://127.0.0.1:27169/provider_benchmark
```

The runner saves raw logs and `server-results.json` and asserts activation, mocked-send counts and expected client retention. The actual server creates indexes and initializes storage in the supplied fixture database. Both production browser bundles are byte-identical to the parent; this change has no UI/configuration/data-format migration.

Rollback: redeploy the recorded parent artifact/commit (`756fca7c`) with its supported Node version and a fresh locked install, or revert the complete M04 child merge. Restart the application process during rollback. This restores eager provider imports and the old APN client-retention behavior; it does not require restoring or changing database contents.
