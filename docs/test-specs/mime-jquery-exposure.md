# M09: MIME lookup and jQuery global exposure

Baseline: modernization 8076d639 (production source matches reviewed 973a2849).

## Changes and retained contracts

Nightscout's two direct `mime.getType` consumers use `mime-types.lookup` instead.
`mime-types` 2.1.35 is already in the runtime graph; it is now explicitly declared.
This consolidates the lookup implementation rather than maintaining a new MIME
database. It does not upgrade to mime-types 3 or remove Express's transitive mime
1.6.0. Superagent still uses mime 2.6.0 in development; that record becomes dev-only
and is removed from a pruned production installation.

All eight configured v1 formats preserve Accept rewriting, original request
metadata and query strings. Existing uppercase v1 non-rewriting behaviour remains
unchanged. V3 JSON/map, CSV, XML/xsl/xsd/rng, uppercase and compound extensions
retain rendered output. Unknown formats and all nine differing MIME mappings
remain 406 responses in the exercised GET renderer. These HTTP contracts pass
against both the old and new implementations. The catalog comparison covered
1,173 old extensions; nine differ (exe, dll, deb, dmg, iso, msi, asc, wav, mpp).
No claim is made that these two general-purpose MIME databases are identical.

A shared browser bootstrap replaces expose-loader's one configured exposure,
`$`, before app widgets and clock initialization. It uses the existing jQuery
module, preserves a preexisting global in production, throws on a collision in
development, and does not add a new window.jQuery global. It uses window rather
than requiring a globalThis polyfill. Webpack's existing ProvidePlugin remains.
Eight isolated cases agree with the old loader's generated code. Actual page,
clock, widget, cache and development HMR behaviour belongs to full browser CI.

## Measurements and validation

The loader's installed files total 24,581 bytes. The direct mime 2.6.0 package
contains 60,114 bytes; only production pruning removes it because test tooling
still requires it. These are package file sizes, not total image or RSS savings.

Using Node 22.23.2 gzip on production bundles, old/new bytes:

| Bundle | Raw | Gzip |
| --- | --- | --- |
| app | 1,042,194 / 1,041,935 | 305,027 / 304,901 |
| clock | 150,606 / 150,191 | 61,497 / 61,338 |
| reports | 170,335 / 170,335 | 50,700 / 50,699 |

Admin/profile/food sizes are unchanged. The report delta reflects changed shared
module references. Do not infer a server-memory saving from these measurements.

Reproduce focused contracts with:
`node node_modules/mocha/bin/mocha.js tests/mime-negotiation.test.js tests/jquery-global.test.js`.
Both Node floors pass all eleven cases. Changed-source lint has zero errors and
one existing dynamic-RegExp warning. Clean install/build passes. Full backend,
browser, Docker/pruned-runtime and current-base CI are required before merge.

The full Node 22 backend suite passed 1,975 cases with one existing pending
case. Initial browser testing detected ProvidePlugin rewriting an aliased global
reference; the bootstrap now uses a function parameter to preserve the real
global access. The corrected actual-page lifecycle regression passes; the full
browser suite is being repeated before merge.
