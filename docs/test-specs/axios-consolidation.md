# Axios consolidation (M09)

Upgrade the IMPORT_CONFIG client from Axios 0.33.0 to 1.20.0. Connect already
uses 1.20.0 and declares ^1.18.1, so both consumers and the cookie wrapper can
resolve one installation without the Connect-specific Axios override. Remove
that override after verifying the complete resolution tree and actual consumers.
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
between the clients over repeated cycles. Actual Connect MiniMed/Dexcom HTTPS
transport tests remain enabled. No UI change is intended.

## Evidence and remaining gates

The initial adapted 28 Axios/boot cases pass on Node 22.23.2 and 24.20.0.
With shared-client isolation assertions and actual MiniMed/Dexcom transport
wrappers, 30 cases pass on Node 22. The dependency tree resolves one Axios
1.20.0 installation for all consumers without the override. Full combined-base
validation, clean reinstall, production pruning, hosted CI and package/bundle
measurements remain outstanding. No runtime-memory saving is claimed.

Upstream: [Axios 1.20.0 release](https://github.com/axios/axios/releases/tag/v1.20.0).
