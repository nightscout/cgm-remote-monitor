# Axios consolidation (M09)

Upgrade the IMPORT_CONFIG client from Axios 0.33.0 to 1.20.0. Connect already
uses 1.20.0 and declares ^1.18.1, so both consumers and the cookie wrapper can
resolve one installation without the Connect-specific Axios override. Remove
that override after verifying the complete resolution tree and actual consumers.
Axios is also the only follow-redirects parent and now requires ^1.16.0; removing
its 1.16.0 override leaves the lockfile byte-identical and resolves the same
maintained release. Both overrides are redundant in the reviewed graph.
The M19 decision to retain a proxy-aware client still applies; this change does
not enable a process-wide native-fetch proxy policy.

## Application contracts and migration decisions

Axios 1 uses AxiosHeaders in interceptors and makes error redaction opt-in.
The importer sets an explicit password/authorization/proxy-authorization
redaction policy. Its existing fixed-message/numeric-status diagnostics still
protect full URLs, query credentials and imported settings; generic Axios error
serialization is not a substitute for that application boundary.

The initial version-only change failed three older library-specific probes:
default redaction, inherited fields in an explicitly supplied Basic-auth object,
and null-prototype headers. Header probes now use AxiosHeaders.set/get, and the
redaction tests exercise the supported explicit policy. Authentication coverage
runs the actual import boot stage with inherited username/password fields and
with explicit URL credentials over two cycles. No inherited credentials reach
the server, and the intended URL credentials still work. Axios 1.20 can read
inherited fields inside a caller-supplied auth object; the importer does not
accept that configuration shape and constructs requests from a URL and its own
options. No arbitrary-configuration compatibility is claimed.

The actual import stage retains environment proxies, proxy authentication,
NO_PROXY, URL authentication, wrapped/flat JSON and nested merging, redirects,
decompression, failure continuation, and credential-safe diagnostics. Timeout
and cancellation policy are unchanged. The newer proxy client supports CIDR
NO_PROXY matching; deployments should retain their intended bypass policy.

Shared-module regressions alternate Connect cookie/session requests with real
config imports, checking that cookies and bearer credentials do not cross
between the clients over repeated cycles. An encoded Unicode/password test
exposes an older Axios 0.33 bug: its URL Basic-auth parser truncates the password
at the first colon. The 1.20 importer sends the complete decoded password; the
new actual-boot probe fails on the baseline and passes on Node 22 and 24.
Actual Connect MiniMed/Dexcom HTTPS
transport tests remain enabled. No UI change is intended.

## Evidence and remaining gates

After refreshing onto Express merge 25a87cea, a clean install/build succeeds,
all 2,007 backend cases pass (one existing pending), and the 30 Axios/Connect
transport cases pass on Node 22.23.2 and 24.20.0. Expanded encoded-credential
assertions also pass on both versions. The dependency tree resolves one Axios
1.20.0 installation and follow-redirects 1.16.0 without either override.

The production lockfile has 290 package records versus 292. Summing installed
production package files on ARM64, excluding nested node_modules from each
package to avoid double counting, gives 61,921,545 bytes versus 62,941,572: a
reduction of 1,020,027 bytes. All six production browser bundles are byte-identical.
This is not a Docker-image or runtime-memory measurement.

After pruning development and optional dependencies, the full runtime startup,
config import, six page/bundle and static/Socket.IO asset checks pass on both
Node versions. Hosted current-base CI remains required before merge.

Upstream: [Axios 1.20.0 release](https://github.com/axios/axios/releases/tag/v1.20.0).
