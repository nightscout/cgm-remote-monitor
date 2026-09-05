# Connector loading and lifecycle regression

M03 defers the `nightscout-connect` import until a source is configured. The legacy BRIDGE-to-CONNECT migration runs first: valid bridge credentials still enable Dexcom Share automatically unless the explicit legacy opt-out is set. Enabled and invalid configurations continue through the same upstream factory and validation.

The review also found that the connector subscribes to `tearDown` while Nightscout's bus emits `teardown`. The new once-only listener stops the returned connector on the actual Nightscout event. This fixes an existing shutdown leak; it does not change polling intervals or data transformation.

## Regression coverage

`tests/connect-lifecycle.test.js` invokes the actual registered setupConnect stage. It checks absent/empty/false sources without importing the package, bridge migration ordering, explicit legacy mode, explicit CONNECT precedence, real invalid-credential errors, and exactly one stop after repeated teardown events. A real connector authenticates against a loopback HTTP source over two independent startup/shutdown cycles; its actor is running before teardown and stopped afterwards. The new tests produce seven failures on parent `9205ea30`, including the real actor remaining running after teardown.

The local source fixture validates activation/authentication and shutdown, not a complete remote-provider import workflow. Existing connector/bridge dependency and API tests remain required. No live provider credentials are used.

## Matched whole-server measurements

Measured on macOS arm64, Node 22.23.2, MongoDB 6.0.27, identical locked dependencies and production bundles, empty isolated database, ten local status requests, and forced GC after startup. Final implementation `78141628` versus parent `9205ea30`, seven fresh processes per revision/configuration; both disabled CONNECT and enabled CONNECT against a loopback source were exercised. Other integrations were disabled. This is a startup fixture, not a representative patient-data soak test.

| Configuration / metric | Parent median (range) | Updated median (range) |
| --- | --- | --- |
| Disabled: post-GC heap bytes | 45,613,576 (45,613,536–45,618,040) | 41,427,928 (41,423,800–41,430,672) |
| Disabled: RSS bytes | 163,807,232 (162,119,680–164,282,368) | 150,683,648 (150,110,208–152,125,440) |
| Disabled: loaded modules | 1,263 | 1,169 |
| Enabled: post-GC heap bytes | 46,601,768 (46,593,976–46,606,632) | 46,585,320 (46,576,368–46,589,520) |
| Enabled: RSS bytes | 164,069,376 (162,693,120–165,036,032) | 164,315,136 (161,431,552–165,101,568) |
| Enabled: loaded modules | 1,263 | 1,263 |

Disabled post-GC heap decreases by 4,185,648 bytes (about 4 MiB); RSS medians differ by about 12.52 MiB, with allocator/platform variability. Enabled results show no material memory reduction. Disabled listener/timer counts are unchanged; enabled startup adds one intentional teardown listener. The real actor stays running after baseline teardown and stops after updated teardown. Packages remain installed, so no package-size saving is claimed.

Startup medians were 386/344 ms disabled and 382/384 ms enabled. These short local timings are diagnostic only, not a performance guarantee. The probe records every latency, memory sample, module count, active resource, and event-listener count in JSON.

Reproduce with both checkouts installed and production-built, a disposable MongoDB database, and Python 3 plus Node with `--expose-gc` support:

```sh
python3 tools/audits/connect-server-probes.py \
  /absolute/parent-checkout /absolute/current-checkout /absolute/output-directory \
  --node /absolute/node \
  --mongo-uri mongodb://127.0.0.1:27169/connect_benchmark
```

Use only an isolated fixture database: the real server creates indexes and initializes its normal storage. The runner supplies test configuration and a loopback source, saving raw logs and `server-results.json`. The first exploratory run omitted CONNECT from ENABLE; those invalid enabled samples were discarded and all configurations rerun with explicit activation assertions.

Rollback: revert the implementation commit and redeploy the prior artifact. No schema, persisted data, settings, or API formats change. This rollback also restores the previous shutdown defect, so account for connector actors during the rollback.
