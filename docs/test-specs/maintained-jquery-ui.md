# Maintained selective jQuery UI candidate (M28)

Replaces jquery-ui-bundle 1.12.1-migrate with jquery-ui 1.14.2 while retaining
jQuery 3.7.1. The app imports dialog, droppable and sortable modules. Dialog's
AMD dependencies retain button, draggable, mouse, resizable, positioning,
keyboard, focus and widget support. Unused datepicker/menu/tabs/accordion widgets
are no longer pulled in through the all-in-one bundle. Flot is unchanged.

The [upstream 1.14 migration guide](https://jqueryui.com/upgrade-guide/1.14/)
documents removed APIs, changed defaults and reduced legacy browser support.
The candidate does not enable the legacy 1.11 API compatibility flag. Current
Chromium/Firefox/WebKit remain the CI target; this is not a promise of IE support.
Nightscout's remaining plugin and device compatibility checks are still required.

## Theme adaptation

The existing 1.11.4 light/dark themes contain Nightscout's palettes and image
assets. They are retained, with palette selectors extended to the current button
markup. Maintained core/button/dialog/draggable/resizable/sortable structure CSS
is imported through webpack's existing inline style runtime. The CSS rule admits
only jquery-ui's base theme directory from node_modules; other dependency CSS
behavior is unchanged. This avoids an extra emitted CSS asset/source-map conflict.

A JS-only upgrade failed both new theme tests: visible button width exceeded its
label by only four pixels. Maintained structure CSS restores the padding. Visual
inspection then found browser-default button colors; the palette adaptation and
explicit computed-color checks resolve that separate regression. Theme images
are served from the actual source assets in the owned fixture. The two theme
cases also drag and resize a dialog, reopen it twice and check focus restoration.
These component screenshots/checks are not full application visual equivalence.

## Evidence and remaining gates

Based on #8673 (d48be5e5), so its authorization-editor fix and eight regressions
must integrate first. Initial clean Node 22 install/build passed. After the
structure-CSS fix, 38 widget/admin/full-page startup cases passed on Chromium
(Node 22.23.2) and WebKit (Node 24.20.0), including authentication and reconnect.
After the final palette adaptation, the ten widget/admin cases passed again on
both engines; light/dark screenshots were inspected. Full hosted CI including
Firefox, food drag/drop/sorting with persisted order and totals, the remaining
application dialogs, HMR/offline CSS behavior and target-device accessibility
checks remain required. Do not merge this candidate based only on these results.

`../audits/jquery-ui-bundle-comparison.json` records a matched Node 22 production
comparison against d48be5e5. Main app JS is 329,895 -> 295,592 gzip bytes (34,303
bytes smaller); the retained theme CSS increases by 202/208 gzip bytes for dark/
light. The npm package itself increases from 1,283,590 to 4,610,862 installed
regular-file bytes: this is a browser-transfer reduction and maintained-package
migration, not an installed-disk or server-memory saving. The lock replaces one
package path with one; no retained dependency record/version changes.

M28 remains open. Selective maintained modules are a candidate step toward the
final retain/narrow/replace decision; food interaction coverage, native-dialog
comparisons, Flot review and whole-browser cost/compatibility evidence remain.

## Food drag/drop and sorting follow-up

`tests/browser/food-widget-interactions.test.js` opens the production food page
with owned food/quick-pick records. Over two cycles it drags the original food
into different quick picks, changes portions, checks displayed carbohydrate
totals, drags the quick-pick ordering and checks each serialized PUT's identifier,
position, food identifier, portions and carbohydrate total. It requires exactly
one update per quick pick and preserves the source food row. These assertions
cover the browser/API boundary; they do not claim MongoDB persistence.

The same case passes on the old UI bundle at d48be5e5 with Chromium/Node 22 and
on this candidate with Chromium/Node 22 and WebKit/Node 24. Touch and keyboard
alternatives, server round-trip reloads and full device/accessibility evidence
remain open. #8673 has now merged into integration; this candidate is refreshed
onto that merge before its next CI run.
