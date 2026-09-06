# MiniMed retirement acceptance evidence

The maintainer authorized replacing local mmconnect with Nightscout Connect in
15.0.9. The candidate removes the plugin and minimed-connect-to-nightscout,
including its obsolete request stack. Migration is described in
[the runtime guide](../runtime-upgrade.md#legacy-minimed-mmconnect-retirement-in-1509).

## Completed candidate checks

- Complete credential mapping, explicit Connect precedence, EU/US/custom server,
  required account country, conflicting sources and repeated application.
- Actual registered boot stage: no connector imports on conflicting feeds or
  missing country; one Connect instance and one teardown per lifecycle.
- Removed obsolete request/HAR tests; preserved relevant qs and Axios consumer
  regressions through Express and Connect. Sixty-five focused compatibility and
  dependency checks pass on Node 22.23.2 and 24.20.0 with the fixed package pin.
- Clean install and production build on Node 22.
- Lockfile removes 32 package paths, adds none. Remaining shared packages that
  lose their production consumer become dev-only; no unrelated retained package
  versions change. Connect is updated to immutable commit
  5349d479f84fe455c4a0412dc9df53e84cd2582d.
- Production npm audit on 2026-09-06 reports zero known vulnerabilities. This is
  registry evidence, not a guarantee that the application is vulnerability-free.
- Upstream Connect PR #64 remains open. All 70 upstream tests pass on both Node
  floors; all 14 new MiniMed logging regressions fail against the old provider.
  These use the actual Axios client with an owned adapter, not vendor traffic.

- Owned HTTPS fixture through the installed package passes on both Node floors:
  rejected untrusted certificates transmit no credentials; successful SSO uses
  real redirects and cookies, fetches data, refreshes tokens, reuses sessions,
  reauthenticates after expiry and clears actor timers across two lifecycles.
  Run `tests/connect-minimed-transport.test.js`; its isolated child process
  loads only the owned CA and never disables certificate verification.
- Full local Node 24/MongoDB 8 suite on the original candidate: 1,910 passing,
  one existing pending. Later transport fixtures and integration-base changes
  require current-head CI.

## Outstanding before integration

- Data review found provider regressions: unmatched/missing lastSG drops the
  latest reading, status uses fetch time and duplicates on repeated polls,
  legacy IOB/uploader fields differ, and a UTC conduit offset can be invalid.
  A separate local Connect patch has seven failing-before/passing-after cases
  and all 77 upstream tests pass on both Node floors. Publication authorization
  is pending; the retirement still pins the logging-only fix.
- Old/new glucose and pump payload comparisons, trend/timestamp handling and
  duplicate behavior across cutover, including the intentional retirement of
  raw CareLink storage. Verify normal pump presentation with replacement data.
- Full current-head CI and exact merge-tree review. Keep the child PR draft until
  implementation-level evidence is complete.

## Release validation

Validate supported real CareLink account/device combinations and hosting
migration before the integration release. Preserve MongoDB 5/6 support, no
historical data deletion, and the documented rollback path. Disabled legacy
adapters already loaded lazily, so dependency removal alone does not demonstrate
an idle-server heap saving. Package/runtime memory measurements belong in the
consolidated M30 comparison.
