# IMPORT_CONFIG client decision

M19 retains the current Axios client for this modernization release. A direct
native fetch replacement changes proxy behavior: on Node 22.23.2 and 24.20.0,
an owned HTTP proxy received zero requests and fetch failed with ENOTFOUND
without NODE_USE_ENV_PROXY; setting it at process startup made the same URL
succeed through the proxy. Enabling a global proxy policy to remove one import
call affects unrelated fetch consumers. A local proxy/CONNECT implementation
would add more maintenance than retaining the existing client. The plan permits
this retain outcome. Revisit a scoped fetch dispatcher when both supported Node
lines provide compatible behavior without another client dependency or a global
routing change. See [Node proxy configuration](https://nodejs.org/api/cli.html#node_use_env_proxy1).

Axios remains ^0.33.0 with the existing connector-specific overrides. This PR
moves the direct declaration from devDependencies to dependencies because the
production augmentSettings boot stage requires it. No installed package entry,
version or integrity changes; the existing transitive consumers already keep
the package installed. This corrects ownership rather than claiming an observed
production outage. No package-size or server-heap saving is claimed.

The HTTP request behavior is retained: JSON Accept header, wrapped/flat JSON
settings and deep merging, automatic redirects/decompression, URL basic auth,
environment proxy authentication and NO_PROXY handling. Non-2xx responses record
a boot error and continue through the stage callback without changing settings.
The stage retains Axios's default unbounded timeout; no new timeout/cancellation
policy is introduced. Existing client-level tests cover explicit timeouts and
subsequent requests. JSON conversion/schema behavior is unchanged.

The review found that the stage logged the full URL and imported settings and
retained response/request details in boot errors. New diagnostics contain only
a fixed message and numeric HTTP status, keeping credentials, query tokens,
headers and imported settings out of logs and the rendered boot-error payload.
Successful settings and failure status/callback behavior remain intact. The
loss of detailed URL/body diagnostics is intentional; users still see that
IMPORT_CONFIG failed and its HTTP status when one is available.

Two regression cases fail against the parent: production declaration and
credential-safe diagnostics. With the fix, 29 Axios/boot contracts pass on each
supported Node floor. New real boot-stage cases repeat authenticated proxy and
NO_PROXY imports twice, and repeat successful/failed credential-bearing imports
twice. Existing MiniMed and nightscout-connect cookie-wrapper/token/reading tests
remain active. The full Node 22/MongoDB 6 backend suite passes 1,670 tests with
one existing pending case. Production build passes and all six browser bundles
are byte-identical to the parent. After npm prune --omit=dev, with Mocha absent,
the actual augmentSettings stage performs two imports on both Node versions and
preserves wrapped/nested settings. A clean reinstall/build restores the full
validation environment. Hosted combined validation remains required.

Rollback restores the declaration and boot stage together. No database,
configuration format or browser bundle change is intended. Do not restore
credential-bearing diagnostics as a routine troubleshooting step.
