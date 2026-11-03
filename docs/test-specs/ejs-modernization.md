# EJS 6 template review (M09)

Upgrade EJS 3.1.10 to 6.0.1. Nightscout still needs a template engine for page
includes, conditional clock views, multiframe pages, boot errors and its service
worker. Reimplementing those semantics locally would add maintenance. The newer
EJS release has no runtime dependencies: Jake, filelist, their nested async and
minimatch/brace-expansion records disappear. Remove the now-unused filelist
minimatch override; other consumers retain their own reviewed overrides.

## Compatibility decisions

The major releases change package exports, remove the legacy `client` option,
and make template locals own-property-only by default. Nightscout uses public
CommonJS `render` and `renderFile`, not private EJS files or client compilation.
Keep the safer locals default; do not enable `unsafePrototypeLocals` to recreate
inherited data access. Actual page locals and relative includes work unchanged.
This is not a claim that EJS can sandbox arbitrary untrusted templates.

Ten regression cases cover five page templates with repeated cached renders,
escaped labels and fresh build identities; multiframe text/attribute escaping;
actual clock HTTP routes and conditional includes; the actual Express boot-error
view engine; parseable service-worker output; and exclusion of inherited locals.
The first nine also pass with EJS 3.1.10. The inherited-locals test intentionally
fails on that baseline and passes on 6.0.1. Both supported Node floors pass all ten;
Node 24 also passes all 34 existing security-header cases. The old test invoking
EJS/Jake/FileList file selection is retired with that removed dependency chain;
the graph-driven brace-expansion and minimatch checks still cover all remaining
consumers.

Thirteen renders of actual page/worker templates are byte-identical to EJS 3.1.10,
including both clock branches, 1/4/8 frames and escaped/Unicode values. Their
output hashes are recorded in [the comparison artifact](../audits/ejs-render-comparison.json).
Full browser and HTTP startup coverage are still required; this comparison does
not prove every possible user setting equivalent.

## Measurements and validation

Compared with Express integration `25a87cea`, the refreshed EJS candidate has
286 production package records versus 292. Installed production package files
on ARM64 total 61,943,591 bytes versus 62,941,572, a reduction of 997,981 bytes.
The sum excludes nested node_modules in each package to avoid double counting.
Five records disappear entirely and balanced-match becomes development-only.
All six production browser bundles are byte-identical. These are installed file
and bundle measurements, not Docker-image or server-memory savings.

A clean Node 22 install/build passes with optional dependencies omitted and reports
zero audit vulnerabilities. An earlier broad test attempt had no generated
production bundles and was stopped; it is not counted as compatibility evidence.
The corrected Chromium run passes all 552 cases. After pruning development
and optional packages, startup, config import, six pages/bundles, static and
Socket.IO assets, and Unicode SCRAM authentication pass on both Node floors.
The initial backend run passed 2,021 cases with one existing pending case; its
only failure invoked the removed Jake dependency. That obsolete test is now
removed and the 26 combined template/brace-expansion cases pass on both Node
floors. The subsequent clean backend run passes all 2,021 cases with one
existing pending case. After refreshing onto Axios merge `fdad2805`, a clean
install/build, all 66 combined EJS/brace-expansion/Axios/SASLprep/Connect cases
and the complete pruned runtime checks pass on both supported Node floors.
Hosted final-head CI remains required before merge.

Sources: [EJS 6.0.1](https://github.com/mde/ejs/releases/tag/v6.0.1),
[EJS 5 migration notes](https://github.com/mde/ejs/blob/main/RELEASE_NOTES_v5.md).
