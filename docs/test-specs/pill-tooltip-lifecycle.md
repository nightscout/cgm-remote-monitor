# Pill tooltip lifecycle regression

`pluginbase.updatePillText` previously registered a new mouseover/mouseout pair for every update. Each callback captured an old options object. A single hover ran all historical renderers; removing info removed only mouseover handlers and could leave a visible tooltip.

The fix replaces only the `pillTooltip` namespace on every update. Both callbacks are bounded to one per pill, and old options become collectible. Removing info hides the tooltip only if that pill owns it, preserving unrelated plugins' handlers and other pills' visible tooltips.

## Automated regression

`tests/pluginbase.modern.test.js` uses real jQuery and jsdom. It exercises 1, 2, and 100 repeated updates, one visible render per hover, current values, mouseout, info removal while visible, re-addition, jQuery element removal, preservation of unrelated listeners, and independent pills. The added repeated-update test fails against parent `9205ea30` because one hover renders twice already after the first replacement update. It passes with the fix.

## Browser and retention probe

`tools/audits/pill-tooltip-browser.cjs` bundles the actual parent/current module separately and launches seven fresh Chromium processes for each. It checks real mouse hover/mouseout, touch/keyboard parity, removal, handler counts, and WeakRef reachability after forced garbage collection. The fixture deliberately creates 100 updates of 100 information items with 64-character values; this exaggerates retention to make causality measurable. It is not a normal patient workload or a server RSS benchmark.

Observed parent/current post-GC heap growth, in bytes: **1,777,332 / 140,616** (median; min and max matched those values across all seven runs). Retained information arrays: **100 / 1**. Mouseover/mouseout handlers: **100 each / 1 each**. One physical hover invoked **100 / 1** renders. The measured difference is 1,636,716 bytes (about 1.56 MiB) in this synthetic browser fixture; normal savings depend on the number and size of historical updates. No package-size or server-memory reduction is claimed.

Touch and keyboard behavior is compared with the parent, not newly redesigned here. The existing span-based pills do not provide a dedicated keyboard tooltip control; accessibility/interaction improvements belong to the separately planned tooltip/widget modernization (M28).

To reproduce, install the locked dependency tree in both checkouts. Install Playwright in a temporary tooling directory rather than adding it to Nightscout's runtime dependencies, then use its module path and browser executable:

```sh
PLAYWRIGHT_MODULE=/absolute/tooling/node_modules/playwright \
CHROMIUM_EXECUTABLE=/absolute/path/to/chromium \
node tools/audits/pill-tooltip-browser.cjs /absolute/parent-checkout /absolute/output-directory
```

The output directory contains the two standalone probe bundles and `browser-results.json`. Compare matched builds and browser versions; retain raw results when reporting new measurements. Revert the implementation commit to roll back; no stored data, settings, or API formats change.
