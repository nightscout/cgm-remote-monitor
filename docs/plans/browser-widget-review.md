# Browser widget modernization (M28)

Baseline: integration `cbbd4581`, 2026-09-06. This inventory and proposed sequence
advance M28; they do not complete the migration or prove UI equivalence.
`python3 tools/inventory-browser-widgets.py` reproduces the lexical inventory in
`../audits/browser-widget-usage.json`, including source hashes and locked versions.
It includes comments and cannot resolve dynamic method names or aliases.

## Actual consumers and shared contracts

| Component | Consumers | Contracts to preserve |
| --- | --- | --- |
| Dialog | Authentication; bolus calculator food picker; report treatment editor; administration role and subject editors | Translated buttons, Enter submission, focus on open/close, Escape, cancellation, asynchronous saves, validation failures, repeated open/close without duplicate handlers; existing dimensions and mobile overflow |
| Draggable / droppable / sortable | Food editor and quick picks | Cloned same-size drag helper, foodlist scope, rejected-drop reversion, greedy targets, vertical ordering and update callback; persisted food order, quantities and carbohydrate totals |
| Flot core/time/pie/fillbetween | Daily Stats, glucose distribution, hourly statistics, percentile, five Loopalyzer plots | Both glucose units, dates/time zones, empty and sparse datasets, axes/series and repeated renders; plugin initialization order |
| Local Flot candle plugin | `static/report/js/flotcandle.js` | `$.plot.plugins`, processOptions/drawSeries hooks, plot offsets and axis p2c coordinate conversion |
| Help tooltips | Two browser-utils initializers | Replacement is in #8668, including focus/hover/touch dismissal and accessible-name checks; not merged at this baseline |

The five dialog creation sites are distinct from their close calls. Authentication
also uses `$.ui.keyCode.ENTER`. Widget defaults can create additional dependencies
(e.g. dialog dragging/resizing); the absence of an explicit `.resizable()` call
is not evidence that resizable can be removed.

Webpack both provides jQuery identifiers and exposes its shared browser instance.
The app entry eagerly registers jQuery UI for authentication on multiple pages;
it cannot simply be moved to the food page. Reports register Flot after that
shared app entry. The clock entry separately imports jQuery. Light and dark
jQuery UI styles are loaded by HTML page templates, and the service worker caches
the dark stylesheet. Theme assets and cache upgrades belong to any replacement.
Existing parent-wrapper and button-set selectors in admin dialog callbacks depend
on generated jQuery UI markup, not just the `.dialog()` method signature.

## Version evidence and proposed sequence

Registry `npm view PACKAGE version` on 2026-09-06 reports jQuery 4.0.0,
jQuery UI 1.14.2, jquery-ui-bundle 1.12.1-migrate, and Flot 4.2.6.
The lock currently contains jQuery 3.7.1, jquery-ui-bundle 1.12.1-migrate and
Flot 0.8.3. Updating the existing UI bundle package range alone cannot obtain
maintained jQuery UI. Official [UI 1.14.2 notes](https://jqueryui.com/changelog/1.14.2/)
and [jQuery 4 migration guide](https://jquery.com/upgrade-guide/4.0/) establish
upstream compatibility, not compatibility of Nightscout's other plugins.

1. Finish #8668 independently. Do not attribute its browser behavior changes or
   measurements to this inventory.
2. Establish focused real-browser coverage for the five dialogs and food
   drag/drop/reordering over two cycles. Existing page-startup authentication,
   report rendering and admin action tests are useful but are not evidence of
   complete keyboard, touch, focus-restoration or persisted quick-pick coverage.
3. Replace jquery-ui-bundle with maintained jquery-ui and import only required
   widgets plus their actual transitive requirements. Keep jQuery 3.7.1 for this
   comparison so failures can be attributed. Verify both themes and generated
   dialog markup. Measure production app gzip, initial requests and browser heap
   against the same parent/build/runtime before choosing the final module set.
4. Prototype native dialogs separately, beginning with an editor that has bounded
   save/cancel behavior. Native dialog is not a direct replacement for jQuery UI's
   modeless, draggable/resizable dialog defaults. Define and test the intended
   focus, modality, keyboard, touch and layout behavior before replacing each.
   Prefer a small shared adapter only where it reduces maintained complexity.
5. Review Flot 4's distributed entry/plugins and the local candle hooks, then run
   matched report data/axis/render goldens on both units and all three browsers.
   Compare a maintained isolated Flot against replacing an individual plot using
   the existing D3 dependency. Retaining reports-only loading is a requirement;
   no new chart framework is justified by the inventory alone.
6. Review jQuery 4 removed APIs across app and plugins after the UI/Flot consumers
   have migration evidence. Do not force the major through an override. Record
   the final retain/narrow/replace decision with measured costs and regressions.

No runtime code, package, browser-support policy or server-memory claim changes
in this slice. M28 remains open, including actual screen-reader/device evidence,
interaction regression coverage, candidate measurements and final decisions.
