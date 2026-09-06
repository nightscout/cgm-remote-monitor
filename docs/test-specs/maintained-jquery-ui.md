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

## Hot update and cached navigation follow-up

The actual page-entry HMR test now checks all six selected widget methods and
positive button padding after each of two updates to every page entry and the
shared app. The cached-navigation test checks the same widget/style contract on
all five pages while origin bundle downloads are blocked. The temporary button
probe destroys its widget and removes its node after each check.

All 29 HMR/page-startup cases pass on Chromium/Node 22.23.2 and WebKit/Node
24.20.0 against the candidate refreshed onto integration 28f4ea4a. These checks
cover inline UI styles surviving hot updates and cached JS, not arbitrary theme
CSS outages or full offline database functionality. The inventory tool also now
recognizes selected jquery-ui imports and reports absent old packages as null
instead of failing after removal. Remaining application-dialog, persistence,
full CI and device/accessibility gates are unchanged.

## Food storage boundary and independent portions

The food API suite now sends browser-form quick-pick updates through the actual
router, extended form parser and MongoDB adapter, then checks both stored
records and the quick-pick GET response over two cycles. It covers stable IDs,
positions, nested portions/carbohydrates, totals and string flags. The six food
API cases pass on Node 22.23.2/MongoDB 6 and Node 24.20.0/MongoDB 8 locally.

The browser fixture now uses valid 24-hex IDs, retains serialized updates for
subsequent fixture reads and reloads the actual editor to verify reconstructed
order, portions and totals. This browser fixture is not MongoDB: the two tests
prove complementary UI/reload and real API/storage boundaries, not one full
browser-to-Mongo end-to-end session.

An additional no-reload case exposed an existing food aliasing defect on both
the old bundle at d48be5e5 and the UI candidate: adding one food to a second quick
pick changes the first pick's nested portions while leaving its total unchanged
(20 g reported versus 30 g implied by its nested food). The drop handler now
copies the food's fields and initializes portions on that copy, preserving the
source row and independent quick-pick portions. Both no-reload and reload cases
pass on Chromium/Node 22 and WebKit/Node 24 after the fix. This changes production
food behavior to remove shared mutable portion state; it is not merely a test
fixture change. The bundle comparison includes the resulting food-page change.

Fresh full CI and the remaining application-dialog/device/accessibility checks
are still required before merging this candidate.
