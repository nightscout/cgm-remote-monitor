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
  dependency checks plus seven transport/cutover checks (72 total) pass on Node
  22.23.2 and 24.20.0 with the final package pin.
- Clean install and production build on Node 22.
- Lockfile removes 32 package paths, adds none. Remaining shared packages that
  lose their production consumer become dev-only; no unrelated retained package
  versions change. Connect is updated to immutable commit
  c962a13fee9a7a5ca160ab5e3fb231d35cadf294.
- Production npm audit on 2026-09-06 reports zero known vulnerabilities. This is
  registry evidence, not a guarantee that the application is vulnerability-free.
- Upstream Connect PRs #64 and #65 remain open. All 78 upstream tests pass on both Node
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

## Data cutover checks

- The candidate now pins the data fixes in upstream Connect #65 (stacked on #64).
  Seven data regressions fail against the prior provider; all 78 upstream tests
  pass on both Node floors including the internal-output logging regression.
- Six installed-package cutover cases compare glucose and pump/Guardian fields
  against goldens captured from retired minimed-connect-to-nightscout 1.5.8 using
  owned EU/UTC payloads. They preserve existing trends, timestamps, IOB, uploader
  battery and pump selection values; repeated cutover batches emit no duplicate
  status. A backfill case verifies old measurements retain their age rather than
  appearing newly observed. Device identity deliberately changes to Connect's
  source URI; raw
  CareLink records are no longer produced. These are bounded fixtures, not a
  claim covering every service/device/timezone payload.

## Outstanding before integration

- Full current-head CI and exact merge-tree review. Implementation fixtures are
  complete; live vendor/hosting checks remain integration-release gates.

## Release validation

Validate supported real CareLink account/device combinations and hosting
migration before the integration release. Preserve MongoDB 5/6 support, no
historical data deletion, and the documented rollback path. Disabled legacy
adapters already loaded lazily, so dependency removal alone does not demonstrate
an idle-server heap saving. Package/runtime memory measurements belong in the
consolidated M30 comparison.
