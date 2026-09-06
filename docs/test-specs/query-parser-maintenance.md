# Query parser maintenance

Update both the global and request-specific qs overrides from 6.15.1 to
6.16.0. These must agree so the legacy bridge client does not retain a
vulnerable private copy. The lockfile upgrades only qs and side-channel;
other changes supply missing registry/integrity metadata for retained paths.

Retain qs: Express and request consume its nested object/array format, used
by Nightscout's find filters. URLSearchParams is not a compatible replacement
for this format. This slice does not change parser configuration or limits.

The upstream changelog documents fixes to non-callable constructor.isBuffer,
nullable comma serialization, explicit comma-array limits and malformed
bracket parsing. See https://github.com/ljharb/qs/blob/main/CHANGELOG.md and
https://github.com/advisories/GHSA-4mjr-xmp4-gh2g.

Seven new cases resolve qs through its actual Express/request consumers and
exercise the request query adapter. Five fail against the previous version:
two non-callable-isBuffer crashes, two missing explicit-limit rejections and
one nullable-comma crash. Existing nested-filter/native-querystring cases
pass against both versions. Comma nulls retain empty positions; bracket comma
groups retain nested array shape. Neither is silently flattened by tests.

The combined 36 new/existing Express cases pass on Node 22.23.2 and 24.20.0,
including 25-value filters, nested dates, large form arrays, body-size and
parameter limits, prototype handling and unicode. Full backend, browser,
clean install/build and hosted gates remain required before merge.

No application policy, persisted format or UI is intentionally changed.
Malformed bracket inputs may parse differently as documented upstream;
normal Nightscout filter/form contracts are the compatibility gate. Rollback
restores both overrides and the lockfile together. This is one M09 audit
slice; remaining advisories and unmaintained bridge dependencies stay open.
