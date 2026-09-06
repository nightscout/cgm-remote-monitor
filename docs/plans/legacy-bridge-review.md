# Legacy bridge dependency and TLS review (M09/M29)

Baseline: modernization integration `0181cc99`, 2026-09-06. The production-only
lockfile audit reports four moderate affected package records, zero high or
critical: request, its private uuid, and the two bridge packages that depend
on request. This is the registry audit result, not a finding that the server
has only four risks. Full-development audit and other dependency-major reviews
remain separate. Raw audit and inspected source hashes are in `docs/audits`.
Installed source versions were checked against the lock: request 2.88.2,
private uuid 3.4.0, share2nightscout-bridge 0.2.12 and
minimed-connect-to-nightscout 1.5.8.

| Finding | Current evidence | Disposition |
| --- | --- | --- |
| request cross-protocol redirect SSRF | Advisory affects request through 2.88.2 with no patched request release. Inspected bridge request sites use POST without followAllRedirects; request's default redirect code does not follow POST redirects. | Narrow source review suggests the reported redirect mechanism is not used by these call sites. Actual owned redirect/transport tests are still required; do not dismiss the advisory globally. |
| private UUID buffer bounds | request imports only uuid/v4 in multipart/auth/oauth and calls it without a supplied buffer. Advisory concerns v3/v5/v6 with a buffer. | No affected call found in the inspected request consumer. Preserve this scope; it does not prove all private UUID consumers everywhere are safe. |
| Dexcom TLS verification disabled | share2nightscout-bridge/index.js sets rejectUnauthorized:false at five request sites, including account authentication, login and glucose reads. | Open security issue independent of the npm audit. Require a strict-TLS fix or validated migration before final release; no global TLS-disable compatibility workaround. |

References: [request advisory](https://github.com/advisories/GHSA-p8p7-x288-28g6)
and [UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

## Reachability and retained feature scope

`lib/server/bridge-connect-compat.js` normally maps configured BRIDGE credentials
to the Dexcom CONNECT source. `setupBridge` skips the legacy package when that
source is active and no legacy override is set. The legacy path remains available
through DEXCOM_BRIDGE_USE_LEGACY/CUSTOMCONNSTR_DEXCOM_BRIDGE_USE_LEGACY,
bridge useLegacy/dexcomBridgeUseLegacy settings, or BRIDGE credentials alongside
a different CONNECT source. Disabled bridges are already lazy-loaded. The package
also accepts an operator-configured BRIDGE_SERVER host; do not assume every
installation uses the default public endpoint.

MiniMed's package index imports its request-based Nightscout upload helper, but
the application plugin uses carelink.Client, transforms and filters, then writes
through Nightscout storage adapters. The standalone package uploader is not the
application plugin's write path. CareLink uses Axios and needs its own TLS,
authentication and redirect review; the request finding is not that review.

## Concrete next steps

1. Obtain the required deployment cases for forced legacy Dexcom, combined
   non-Dexcom CONNECT/BRIDGE and MiniMed. A question is pending; no answer is
   assumed and no feature retirement is authorized by silence.
2. Exercise the actual retained bridge request behavior against owned HTTP/TLS
   fixtures: untrusted CA rejection, redirects, authentication/session refresh,
   polling/cancellation and two data cycles. Use no real credentials or vendor
   account. Confirm the source-derived advisory classifications dynamically.
3. Prefer migration to the existing CONNECT path where its configuration and
   output contracts cover the retained use case. Map credentials, region/custom
   server, intervals, duplicate filtering and partial failures explicitly. Prove
   no double ingestion during cutover and preserve rollback instructions.
4. For cases that cannot migrate yet, prepare a narrowly reviewed upstream
   transport/TLS fix or a maintained compatible transport replacement. Recheck
   request/UUID removal and package cost; do not override private uuid to an
   incompatible major or inject a global request/TLS monkey patch.
5. Remove a legacy package only after required functionality has a validated
   replacement and an explicit release notice. Publish final audit classification
   and include live deployment/rollback evidence in M29/M30.

No production behavior, dependency version or support policy changes in this
review. The TLS issue remains unresolved; M09 and M29 remain open.
