# Maintained server sanitizer

Update sanitize-html from 2.17.5 to 2.17.7 now that the supported Node floors
are 22.23.2 and 24.20.0. The package requires Node >=22.12.0. This also updates
its htmlparser2 dependency from 10.1.0 to 12.0.0 and the associated DOM parser
packages; the lockfile changes are confined to that dependency tree.

The release addresses GHSA-g8qq-57p8-ggw5 and GHSA-jxwj-j7wr-gfrw.
Nightscout already excludes the SVG/SMIL and raw-text elements involved in
those reports. This update maintains the parser rather than claiming an
exploitable application path. It does not reintroduce jsdom, expand the
allow-list or change traversal/string budgets.

Existing sanitizer-differential browser cases include SVG animate URI lists,
solidus raw-text closing tags, SVG/Math nesting and three rounds of native
HTML parsing. The full corpus checks direct HTML, EJS escaping and textContent
output paths; API and WebSocket suites exercise write purification. Retain
these observable regressions rather than add a version-only assertion.

Validation gates: full backend, core/dependency checks, production build,
Chromium/Firefox/WebKit on both Node floors, npm 12 install and native Docker
startup. Review unexpected output changes before merging; parser updates are
not assumed behavior-neutral merely because the root version is a patch.

Rollback restores the package and lockfile together. No persisted schema or
sanitizer policy migration is introduced.
