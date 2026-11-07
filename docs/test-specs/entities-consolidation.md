# Entities consolidation (M09)

## Change and compatibility

Upgrade the direct `entities` dependency from 6.0.1 to 8.0.0. The existing
`htmlparser2` and `dom-serializer` consumers already require 8.0.0; npm now
resolves all three consumers to one installed copy without an override.
No other retained package version changes.

The [upstream release notes](https://github.com/fb55/entities/releases)
identify version 8 as ESM-only, requiring Node >=20.19.0 and removing deprecated
exports. Nightscout uses the public `entities/decode` (`decodeHTML`) and
`entities/escape` (`escapeText`) exports. These remain available through
synchronous `require` on our supported Node 22.23.2 and 24.20.0 floors and
through webpack's browser bundling. The removed deprecated exports are not
used by Nightscout's direct consumers.

Retain this dependency: the application needs HTML named/numeric reference
decoding, including malformed-reference rules, on both server and browser.
A local replacement would duplicate standards data and security-sensitive
parsing logic. Consolidation reduces duplication without taking on that parser.

## Regression requirements

- `tests/utils.test.js` covers nullish values, named and numeric references,
  multi-codepoint and supplementary Unicode, Windows-1252 numeric mapping,
  invalid scalar values, unknown references, missing semicolons, single-layer
  decoding and inert HTML text output for encoded markup.
- Existing API/websocket purification and browser sanitizer/rendering suites
  must preserve stored identifiers, allowed markup and escaping at output.
- Clean production and development builds must support the ESM exports.
- Run core tests on both supported Node floors and the existing hosted
  backend, real-browser, database and Docker matrix before merge.

An isolated 2026-09-06 comparison against integration `07b4389e`'s unchanged
HTML helpers and purifier used all 2,231 Python HTML5 reference keys in three
contexts (alone, embedded text and paragraph markup), plus six malformed or
hostile inputs. All 6,699 inputs matched across `toTextContent`, `textAsHtml`
and `sanitizeString`: 20,097 comparisons with zero differences on each Node
floor. This is additional compatibility evidence, not proof for all inputs.

## Measured scope of savings

Summing regular-file sizes in the installed entities package directories:

| Package files | Before | After |
| --- | ---: | ---: |
| Root entities | 540,551 bytes (6.0.1) | 236,002 bytes (8.0.0) |
| Nested entities under dom-serializer | 236,002 bytes | 0 |
| Nested entities under htmlparser2 | 236,002 bytes | 0 |
| Total | 1,012,555 bytes | 236,002 bytes |

This removes two installed package paths and 776,553 bytes (about 758 KiB).
The baseline installation is the preceding integration tree `ad4a8cd5`;
`07b4389e` changed only documentation. These are uncompressed package-file
bytes, not filesystem allocation, Docker image, browser transfer or runtime
memory measurements. No server RAM saving is claimed.

## Browser resource tradeoff

A fresh production build on Node 22.23.2 compared the unchanged baseline with
this upgrade. Direct property imports in `lib/utils/html.js` let webpack retain
only the used ESM exports; destructuring after Babel otherwise retained unused
decoder exports and exceeded the clock budget. Existing resource limits remain
unchanged.

| Entry | Baseline gzip bytes | Candidate gzip bytes | Change |
| --- | ---: | ---: | ---: |
| App | 303,816 | 305,212 | +1,396 |
| Clock | 61,301 | 62,703 | +1,402 |
| All application entries (excluding independent clock) | 374,508 | 375,904 | +1,396 |

Reports, admin, profile and food entry sizes are unchanged. Accept this bounded
browser transfer increase for package consolidation; do not describe this change
as a browser-size reduction. Validate output and startup with the real-browser
suite, including existing page-resource checks. The first local browser run and
first backend run overlapped an unrelated development build and are not accepted
as final production validation; final checks use stable production assets.
