# Connector loading and lifecycle regression

M03 defers the `nightscout-connect` import until a source is configured. The legacy BRIDGE-to-CONNECT migration runs first: valid bridge credentials still enable Dexcom Share automatically unless the explicit legacy opt-out is set. Enabled and invalid configurations continue through the same upstream factory and validation.

The review also found that the connector subscribes to `tearDown` while Nightscout's bus emits `teardown`. The new once-only listener stops the returned connector on the actual Nightscout event. This fixes an existing shutdown leak; it does not change polling intervals or data transformation.

## Regression coverage

`tests/connect-lifecycle.test.js` invokes the actual registered setupConnect stage. It checks absent/empty/false sources without importing the package, bridge migration ordering, explicit legacy mode, explicit CONNECT precedence, real invalid-credential errors, and exactly one stop after repeated teardown events. A real connector authenticates against a loopback HTTP source over two independent startup/shutdown cycles; its actor is running before teardown and stopped afterwards. The new tests produce seven failures on parent `9205ea30`, including the real actor remaining running after teardown.

The local source fixture validates activation/authentication and shutdown, not a complete remote-provider import workflow. Existing connector/bridge dependency and API tests remain required. No live provider credentials are used.

## Matched whole-server measurements

Measured on macOS arm64, Node 22.23.2, MongoDB 6.0.27, identical locked dependencies and production bundles, empty isolated database, ten local status requests, and forced GC after startup. The integration refresh compares `b2099052` against modernization parent `0f49bc70` (including M01/M02/M07), seven fresh processes per revision/configuration. Both disabled CONNECT and enabled CONNECT against a loopback source were exercised. Other integrations were disabled. The subsequent merge of MongoDB support-policy PR #8609 changes only CI/docs, not these runtime sources or dependencies. This is a startup fixture, not a representative patient-data soak test.

| Configuration / metric | Parent median (range) | Updated median (range) |
| --- | --- | --- |
| Disabled: post-GC heap bytes | 45,334,312 (45,333,288–45,338,648) | 41,153,288 (41,153,016–41,161,920) |
| Disabled: RSS bytes | 162,643,968 (161,415,168–163,790,848) | 151,486,464 (149,766,144–151,912,448) |
| Disabled: loaded modules | 1,263 | 1,169 |
| Enabled: post-GC heap bytes | 46,319,616 (46,312,608–46,322,256) | 46,312,440 (46,305,336–46,313,376) |
| Enabled: RSS bytes | 163,856,384 (159,547,392–164,413,440) | 163,692,544 (161,841,152–165,462,016) |
| Enabled: loaded modules | 1,263 | 1,263 |

Disabled post-GC heap decreases by 4,181,024 bytes (about 3.99 MiB); RSS medians differ by about 10.64 MiB, with allocator/platform variability. Enabled results show no material memory reduction. Disabled listener counts are unchanged; the sampled timeout counts have median seven on both revisions (parent range five–seven, updated seven). Enabled timeout counts are nine on both revisions, and startup adds one intentional teardown listener. The real actor stays running after baseline teardown and stops after updated teardown. Packages remain installed, so no package-size saving is claimed.

Startup medians were 372/350 ms disabled and 382/391 ms enabled. Status-request latency medians were 0.92/0.91 ms disabled and 1.01/1.09 ms enabled; sample ranges overlap (parent/updated: 0.44–14.73/0.47–14.41 ms disabled, 0.51–12.10/0.45–12.07 ms enabled). These short local timings are diagnostic only, not a performance guarantee. The probe records every latency, memory sample, module count, active resource, and event-listener count in JSON.

On the refreshed integration sources, a clean locked install/production build, full main suite (1,979 passing, three existing pending), client-core (283) and dependency compatibility (317) passed. Final child CI must also validate the current integration merge before it is merged.

Reproduce with both checkouts installed and production-built, a disposable MongoDB database, and Python 3 plus Node with `--expose-gc` support:

```sh
python3 tools/audits/connect-server-probes.py \
  /absolute/parent-checkout /absolute/current-checkout /absolute/output-directory \
  --node /absolute/node \
  --mongo-uri mongodb://127.0.0.1:27169/connect_benchmark
```

Use only an isolated fixture database: the real server creates indexes and initializes its normal storage. The runner supplies test configuration and a loopback source, saving raw logs and `server-results.json`. The first exploratory run omitted CONNECT from ENABLE; those invalid enabled samples were discarded and all configurations rerun with explicit activation assertions.

Rollback: revert the implementation commit and redeploy the prior artifact. No schema, persisted data, settings, or API formats change. This rollback also restores the previous shutdown defect, so account for connector actors during the rollback.
