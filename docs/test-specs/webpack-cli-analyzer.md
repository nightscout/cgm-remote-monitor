# Webpack CLI and bundle analyzer maintenance (M09 partial)

Upgrade webpack-cli 4.10.0 to 7.2.3 and webpack-bundle-analyzer 4.10.2 to
5.3.2, the registry releases reviewed on 2026-09-06. Both require Node >=20.9;
Nightscout's supported Node 22/24 floors satisfy this. Keep webpack 5.110.3.
These remain development dependencies, excluded from the pruned runtime.

Review sources: [CLI releases](https://github.com/webpack/webpack-cli/releases)
and [analyzer changelog](https://github.com/webpack/webpack-bundle-analyzer/blob/main/CHANGELOG.md).
CLI 5/6/7 retire old commands and flags, change explicit entry handling, and
use dynamic import before interpret to load configuration. Nightscout does not
use the removed flags, CLI programmatic API or webpack-dev-server. Its CommonJS
configuration and production/development/profile/JSON commands remain supported.
Analyzer 5 adds compression/display options and changes its WebSocket consumer
from ws 7 to 8. The retained resource-limit tests now use Receiver's options
object, preserving the same limits and adversarial frames. Resolve the lockfile
with legacy peer mode disabled: CLI needs optional js-yaml 4/5 while NYC retains
its compatible nested js-yaml 3. Versions and copy counts are unchanged by this
hoisting correction. A real YAML-config CLI build protects the resolution.

Regression coverage:

- Run the installed CLI in both build modes with a disposable CommonJS fixture;
  require parseable profiling JSON, expected module/asset and nonempty bundle.
- Feed those actual stats and bundles through the installed analyzer CLI;
  require JSON reports with parsed/compressed sizes and standalone HTML reports.
- Require invalid configuration to exit unsuccessfully with the invalid option
  identified. Fixtures never replace application assets or open a browser.
- Preserve fragment/chunk bounds, consecutive-message counter reset and real
  localhost WebSocket Unicode/fragmented-binary exchanges over two connections.
- Run the real application production/development builds and existing backend,
  browser, HMR and resource-budget checks before integrating the upgrade.

Local validation: clean Node 22 install/build with legacy peer mode disabled,
valid full npm dependency tree, 286 dependency cases on Node 22 and eight
focused CLI/WebSocket cases on Node 24. The actual Node 24 development build
produces reports for all six bundles; the standalone HTML renders in Chromium
without JavaScript errors. Full/production audits report zero known advisories.
The final Node 24 backend run passes 2,079 tests with one existing pending case;
the earlier Node 22 run passed 2,078 before the added YAML case and peer-layout
correction. Hosted Node 22/24 checks remain required on the final head before merge.

Matched clean Node 22 installations have 838 -> 832 lockfile package paths.
Summing regular package-owned files (excluding nested node_modules and symlinks)
gives 201,877,508 -> 202,324,614 bytes: **447,106 more development-tree bytes**,
despite fewer paths. All 276 production lock entries and all six production
application JavaScript bundles are unchanged. No RAM, image-size or build-time
saving is claimed.

No deployment or Nightscout user-interface change is intended. The optional
analyzer's developer report UI gains upstream display/compression features;
it is not served by Nightscout. Restore both manifest/lockfile and Receiver
constructor tests together to roll back. This does not complete M09.

Mocha 12 follow-up: when v4 YAML is needed only as CLI's optional peer, legacy
peer installations omit it. JavaScript builds remain supported; the consumer
regression requires an explicit missing-parser error for YAML configs and also
tests successful YAML builds when the optional peer is installed.
