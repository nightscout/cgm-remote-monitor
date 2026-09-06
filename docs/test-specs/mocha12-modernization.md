# Mocha 12 and native command parsing (M09 partial)

Upgrade Mocha 11.8.0 to 12.0.0, reviewed on 2026-09-06. Its Node requirement
(^20.19.0 or >=22.12.0) supports Nightscout's Node 22/24 floors. This is a
development-only tool; application modules and deployment configuration do not
change. Review [Mocha releases](https://github.com/mochajs/mocha/releases),
including the v12 prerelease breaking changes, and
[js-yaml documentation](https://nodeca.github.io/js-yaml/doc/).

Mocha 12 changes its entry points to ESM, replaces its yargs parsing/respawn
helpers with native Node argument parsing, removes its HTML-encoding dependency,
and updates watcher/glob/worker dependencies. Nightscout calls bin/mocha.js;
it does not call the retired bin/_mocha or internal Mocha APIs. CommonJS tests,
root hooks, glob discovery, parallel execution, nyc coverage and browser hooks
remain required validation gates.

Remove the scoped diff and serialize-javascript overrides: Mocha declares diff
^9 and serialize-javascript ^7.0.2, resolving 9.0.0 and 7.0.5 naturally. Forcing
the old diff 8 override would violate Mocha's new declared range. Other parents'
security overrides remain unchanged pending their own review.

Mocha now resolves js-yaml 5.4.1. Its default YAML 1.2 schema treats `<<` as an
ordinary property, not a merge directive, and rejects ordered-map/executable
tags. Nightscout's test scripts do not rely on YAML merge configuration.
Contributors with private .mocharc.yml files should flatten inherited YAML
values or use a JavaScript configuration before upgrading. NYC retains js-yaml
3.15.2 and webpack CLI retains 4.3.2, with their original merge/ordered-map
security contracts. Tests resolve each parser through its actual consumer.
The v5 compatibility-tag tests explicitly enable those tags solely to retain
merge-work/ordered-map resource tests; separate tests protect the actual default
schema and real Mocha YAML configuration loading.

Regression coverage includes serial/parallel callback and async root hooks,
fluent suite timeouts, assertion failure exit codes and diffs, setup failure,
timeout failure, quoted grep values with Node-flag respawning, and xunit XML
escaping after removal of the HTML helper. YAML tests cover all three consumers,
prototype keys, executable tags, duplicates, alias limits, and bounded merge
work. Dependency-test totals change when duplicate package copies disappear;
the dynamically generated duplicate-copy cases are not manually removed.

Matched clean Node 22 installations: 832 -> 792 package paths and
202,324,614 -> 192,961,958 package-owned regular file bytes, excluding nested
node_modules and symlinks (**9,362,656 bytes removed from the development tree**).
All 276 production lock entries and all six production JavaScript bundles are
unchanged. These are installed package measurements, not server RAM, image-size
or build-time savings. No Nightscout user-facing UI change is intended.

Full current-head CI, browser hooks and coverage validation remain required
before integration. Roll back manifest, lockfile and consumer-version tests
together. This review does not complete the remaining M09 work.
