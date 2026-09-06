# Consolidate semver on the maintained root release (M09 partial)

The only direct runtime use of semver is the shared Node startup policy. Tests
also use satisfies, valid and major. Keep the established range/prerelease
parser rather than introducing a local parser for package.json engines.

Upgrade the root from 6.3.1 to 7.8.5, the registry release checked on 2026-09-06.
The Node floor is compatible (upstream requires Node >=10); Nightscout's accepted
Node versions and package.json engine range do not change. The used CommonJS APIs
remain available. Review reference: [upstream changelog](https://github.com/npm/node-semver/blob/main/CHANGELOG.md).

This allows twelve private 7.x copies to use the root instance. One private 6.3.1
copy remains for make-dir's declared 6.x range; do not force it across a major.
No unrelated retained package version changes. The net reduction is eleven
installed paths and two production semver copies.

[Installed-file measurements](../audits/semver-copy-comparison.json) record
1,104,470 fewer bytes across all semver copies and 167,338 fewer production bytes.
These are file sizes from clean dependency trees, not filesystem allocation,
compressed download sizes or a measurement of server RSS/heap.

Validation:

- Clean Node 22 install/production build passes.
- 307 runtime-policy and dependency cases passed on Node 22; eight added JWT
  signing/key-validation cases also passed. Node 24 passed all 315 together.
- The startup tests exercise both server entry points and the public boot API,
  rejecting Node 20, below-floor patches, prereleases and unsupported majors
  before service initialization.
- Both actual production jsonwebtoken consumers (Nightscout and APN) sign and
  verify ES256, RS256 and PS256 tokens over two cycles; they reject incorrect
  algorithms and mismatched EC curves. These exercise semver-dependent key
  validation paths with owned keys and no network/provider traffic.
- Existing dependency tests cover the build/test consumers now sharing semver.
  Full current-head CI remains required before integration.

There is no visual UI change or user configuration migration. Authentication and
runtime startup behavior are relevant regression boundaries. Revert the root
manifest and lockfile together if a consumer regression is discovered.
