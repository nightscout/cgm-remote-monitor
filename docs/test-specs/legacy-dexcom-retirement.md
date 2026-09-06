# Legacy Dexcom retirement validation (M09/M29)

Candidate in progress. The maintainer explicitly authorized retirement in
15.0.9 in favour of Nightscout Connect, superseding the proposed upstream TLS
repair and prior need to retain forced-legacy use cases.

Removes the engine, local plugin and old implementation-only tests. Compatibility
and actual registered boot-stage tests cover credential precedence, EU/custom
server mapping, incomplete configuration, retired overrides, mixed-source errors,
secret-free error text and repeated connector teardown. The other Connect-source
lifecycle test remains active without conflicting legacy credentials; the new
mixed-source test covers that intentionally changed behavior separately.

Sixteen focused compatibility/lifecycle cases pass on both Node 22.23.2 and
24.20.0; a clean Node 22 install/production build also passes. The lock removes
only share2nightscout-bridge; no retained package record changes. Request remains
required by MiniMed, so this does not remove that entire dependency chain.

Required before integration: actual Connect Dexcom transport and ingestion
comparisons, duplicate/backfill/cutover behavior, full CI,
current-base verification and review of deployment/logging behavior. Unit/boot
stage checks alone do not establish a working vendor integration. No real
Dexcom account or live database has been used and no live migration is claimed.
