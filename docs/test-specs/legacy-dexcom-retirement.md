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

## Transport and cutover follow-up

Two owned HTTPS cases pass on both Node floors using the connector's actual
Axios dependency: an untrusted certificate is rejected before any HTTP request,
and an explicitly trusted private CA permits both bare and wrapped account-ID
responses, sessions and mapped glucose over two cycles. Proxy routing is disabled
for the owned fixture only. This is driver-boundary evidence, not a live vendor
or full actor authentication/refresh test.

The actual entries adapter also passes a two-cycle database cutover check on
Node 22/MongoDB 6 and Node 24/MongoDB 8. Connect backfill overlapping a legacy
share2 reading preserves its database ID and yields one reading per timestamp;
repeating the batch preserves the new reading's ID too. Overlapping records'
device field becomes nightscout-connect; the migration note now states this.

Open logging finding: an owned startup probe, before emitting data-processed,
confirms nightscout-connect 0.0.13 logs both configured username and password.
The source logs validated.config and, for invalid configuration, validated.
No live credentials or network request were used. Resolve this in the Connect
dependency before integrating the forced legacy migration; do not suppress
global console output or claim that TLS checks resolve credential logging.

The hosted backend run exposed process-wide TLS bypass inherited from the older
API fixtures (`NODE_TLS_REJECT_UNAUTHORIZED=0`). The transport checks now run in
an owned child process with that override removed, leaving the parent environment
untouched. They pass on both Node floors even when launched from a parent with
TLS verification disabled. This checks the connector's normal TLS defaults rather
than forcing an HTTPS-agent policy into the implementation under test.

The same HTTPS fixture now also exercises the actual Connect builder/poller with
its simulated clock. Across two complete actor lifecycles it reuses an active
session, authenticates again after the configured 24-hour expiry, uses the newly
issued session token for the next glucose request, persists both cycles and
removes all actor timers on stop. This remains owned-server evidence, not a live
Dexcom or deployment validation.

A separate upstream source patch for the logging finding is prepared locally at
commit 9fa2c3c in nightscout-connect. All nine new logging regressions fail against
upstream main and pass with the patch; all 56 upstream tests pass on both Node
floors. It covers startup, Dexcom errors and shared actor context/event logging.
Other source drivers and CLI capture output are outside that patch's privacy
claim. The patch is published as [Connect PR #64](https://github.com/nightscout/nightscout-connect/pull/64).
This draft pins its full commit 9fa2c3c19ecf5cd6e0908ab28d3d9b111774810c;
upstream review remains open. No other dependency package records change.

A clean Node 22 install/production build succeeds with the fixed package. The
packaged Connect startup and HTTPS actor tests fail with the old dependency's
credential/session logging and pass with the pinned fix on both Node floors.
All 17 combined compatibility/lifecycle/isolated-transport cases pass on each
floor (the isolated case contains four owned checks). These tests capture actual
startup console output and the actor logger rather than suppressing logging in
production. Full current-head CI and current-base verification remain required.

Final region review adds an explicit case-insensitive US selector mapping. The
legacy engine treated `BRIDGE_SERVER=US` as its default US endpoint; the older
compatibility helper incorrectly treated it as a hostname. The new repeated
regression verifies the actual Connect validator resolves share2.dexcom.com.
It fails before this fix and passes on both Node floors; the combined focused
suite now has 18 cases. Explicit Connect-region/server settings retain precedence.
