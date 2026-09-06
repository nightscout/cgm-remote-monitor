# SASLprep ownership and authentication validation (M09)

MongoDB 7.6.0 declares @mongodb-js/saslprep ^1.4.11 as an ordinary required
dependency. Nightscout has no direct application consumer. Remove the redundant
root declaration and resolve the driver dependency to 1.5.0. The earlier M01
review retained the declaration to protect installs omitting optional packages.
The current driver graph and explicit authentication validation allow removal. SASLprep remains installed and used at runtime.

Do not replace this algorithm with String.normalize alone. SASLprep includes
mapping, normalization, prohibited-character, bidirectional and Unicode 3.2
unassigned-character rules, as specified by
[RFC 4013](https://www.rfc-editor.org/rfc/rfc4013.html).

## Scope and verification

Comparing the published 1.5.0 dist directory with installed 1.4.11 finds only
code-points-data.d.ts changed. Executable JavaScript, source maps and Unicode
lookup data are byte-identical. The lockfile changes only the root declaration
and SASLprep version/registry metadata. No package-count or server-memory saving
is claimed; ownership is simplified while keeping the maintained dependency.

Ten normalization/rejection cases use the package resolved from the MongoDB
driver and pass on Node 22.23.2 and 24.20.0. They cover RFC examples, non-ASCII
spaces, case preservation, prohibited controls, bidirectional strings and
unassigned code points.

The existing pruned-runtime validator creates a disposable SCRAM-SHA-256 user
in its own loopback test database. It authenticates using both a soft-hyphen
password and its normalized equivalent, checks the authenticated identity, and
requires a wrong password to fail. It repeats the sequence with fresh clients,
closes clients and removes the user. No production account or database is used.
This passes locally on MongoDB 6 with both Node versions after omitting optional
dependencies and pruning development packages. The complete pruned-runtime
startup, config import, six pages/bundles and static/Socket.IO asset checks pass
in both runs. Before the Express integration, the full Node 22 backend suite passed 2,009
cases with one existing pending case. After refreshing onto Express merge
25a87cea, the clean install/build, 47 combined request/authentication cases and
both complete pruned-runtime runs pass again. All six browser bundles are byte-identical; changed test/tool
source lint and clean omit-optional install/build pass. Hosted CI remains
required before merge. See the [package comparison](../audits/saslprep-package-comparison.json)
for per-file hashes of both releases.

The existing Docker jobs additionally resolve SASLprep through the driver and
check Unicode preparation inside the built image. This protects the specific
omit-optional installation path without adding another CI environment. Existing
backend pruned-runtime jobs exercise real authentication across MongoDB 5–8.
