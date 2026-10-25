# Notification deduplication cache retention

M05 changes the recently-sent cache value from the complete notification object to `true`. The consumer only needs presence and TTL. Receipt records retain their existing payload because acknowledgement uses level, group and event name. TTLs, cache-library clone behavior, transport payloads, API/UI behavior and notification configuration remain unchanged.

`tests/pushnotify-cache.test.js` exercises the real installed NodeCache through the actual pushnotify module. Five cases cover duplicate suppression, the 30-second failed-send interval, successful Pushover/Maker extension to 15 minutes, repeated expiry, disabled events, seven-minute acknowledgement, duplicate acknowledgement and failed/successful cancellation across two cycles. Against the parent implementation, the marker assertion fails while the other four cases pass. The broader notification/provider tests cover integration and lifecycle behavior.

## Reproduce the stress comparison

Use two clean, built worktrees, the same Node executable and a disposable MongoDB database. The probe starts the actual server, replaces notification transports with synchronous fixture callbacks, warms the status route and samples allocations during 100 unique notifications followed by 500 duplicates. Every unique notification carries 1,000 objects with unique strings. This is deliberately much larger than ordinary alarms; it demonstrates avoidable cloning/retention, not expected savings for a typical installation.

```sh
python3 tools/audits/notification-cache-probes.py /path/to/parent /path/to/candidate /path/to/results --node /path/to/node --mongo-uri mongodb://127.0.0.1:27169/disposable_notification_probe
```

The runner alternates parent/candidate, with and without receipt responses, seven fresh processes per case. It asserts 100 sends, 500 suppressed duplicates, 100 recent-cache entries, and zero or 100 receipt entries. Raw logs, sampled allocation profiles and `results.json` are written to the output directory. GC runs before/after the workload; pinned NodeCache internals are inspected without invoking another cloning read.

Measured 2026-09-05: parent `d87f77e6`, candidate runtime `0029563f`, Node 22.23.2, MongoDB 6.0.27, provider integrations disabled except fixture transports, identical installed production graph/browser assets. Figures below are median [min–max] bytes across seven processes.

| Metric | Parent | Presence marker |
| --- | ---: | ---: |
| Retained heap growth, no receipts | 31,553,664 [31,528,720–31,554,544] | 109,240 [108,768–109,240] |
| Retained heap growth, receipts required | 38,218,424 [38,217,624–38,228,736] | 31,556,960 [31,555,264–31,565,616] |
| Sampled allocation bytes, no receipts | 277,329,088 [275,748,072–279,173,680] | 38,963,496 [37,383,240–39,330,480] |
| Sampled allocation bytes, receipts required | 318,671,472 [311,395,072–322,781,936] | 78,414,472 [76,654,696–79,440,768] |
| RSS, no receipts | 191,823,872 [191,430,656–192,872,448] | 157,040,640 [156,745,728–158,580,736] |
| RSS, receipts required | 200,015,872 [199,016,448–201,441,280] | 184,614,912 [184,074,240–185,368,576] |

The stress fixture reduces retained growth by 29.99 MiB without receipts and 6.35 MiB when receipt records must retain payloads. RSS is allocator/OS-dependent. Both revisions load 1,032 modules and have identical bus listener counts. Resource snapshots show two pipes, one TCP server and seven TCP sockets; timers are seven except one slow first parent startup with five at the observation point. Cache timer configuration is unchanged; snapshots alone are not a timer-leak proof.

Sampling uses V8's HeapProfiler at a 32,768-byte interval, including samples collected by minor/major GC. Summed `selfSize` values are allocation estimates, not exact allocated bytes. The no-receipt parent profile attributes most allocations to `clone.js` recursive cloning; that path disappears from the candidate's leading allocations. Normalize by the fixed 600 emissions: median sampled bytes/emission falls from 462,215 to 64,939 without receipts and 531,119 to 130,691 with receipts. Bytes/second is not a reduction metric here because the candidate completes the fixture much faster. See [HeapProfiler sampling semantics](https://chromedevtools.github.io/devtools-protocol/v8/HeapProfiler/#method-startSampling).

Instrumented workload median times were 202.51 → 10.11 ms without receipts and 236.01 → 50.70 ms with receipts. These include allocation-profiling overhead and exclude real provider/network latency; they are not application-throughput guarantees. Startup medians remain around 296–300 ms, with cold outliers (parent no-receipt maximum 1,865.59 ms, candidate 466.11 ms). Post-work status-request per-process median ranges overlap: no-receipt parent 0.358–0.501 ms / candidate 0.343–0.431 ms; receipt parent 0.346–0.479 ms / candidate 0.356–0.454 ms. No startup or HTTP-latency improvement is claimed.

## Validation and rollback

Before the provider refresh, the complete Node 22 main suite passed 1,989 tests with three existing pending; client-core passed 283 and dependency compatibility 317. The refreshed combined notification/provider suite passed 84 cases. After refreshing to parent `d87f77e6`, the complete Node 22 main suite passed 2,013 tests with the same three pending; changed-file lint and both builds passed. Both production bundles are byte-identical to the parent (app 1,761,400 bytes; clock 152,131 bytes). Current-parent CI, CodeQL and both native Docker checks remain merge gates. Manifests are unchanged, so there is no package-size saving in M05.

Rollback: deploy the known-good parent artifact or revert the complete M05 child PR. No database, persisted identifier or browser-storage migration is involved. In-memory deduplication and receipts are already process-local and reset on restart in both revisions; use the normal controlled restart procedure rather than running duplicate live notification instances.
