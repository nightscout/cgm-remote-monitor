# M28 browser widget decision

Decision, 2026-09-08: retain jQuery 3.7.1 and selected jQuery UI 1.14.2 modules,
retain the native help tooltips already integrated, and upgrade reports-only
Flot 0.8.3 to 4.2.6 with only the needed core helpers/time/pie/fillbetween/legend
modules. Keep the existing D3 boundary. No framework, new runtime dependency,
or change to the browser-support policy is introduced.

Registry checks on this date returned jQuery 4.0.0, jQuery UI 1.14.2 and Flot
4.2.6. The [jQuery 4 upgrade guide](https://jquery.com/upgrade-guide/4.0/)
reduces supported iOS versions to current/current-1/current-2; that does not
match the older explicit iOS targets still in Nightscout's build policy.
jQuery UI 1.14.2 is [tested upstream](https://jqueryui.com/changelog/1.14.2/)
with both jQuery 3.7.1 and 4.0.0. There is no need to force jQuery 4 to obtain
the selected UI update. Review of removed helper APIs found no direct call in
the application's lib/bundle/static entry sources; that lexical check does
not establish compatibility of dynamic calls, every plugin or old devices.

## Retain selected UI; native dialog is a separate future migration

The five application dialog sites depend on open/close focus, Enter/Escape,
asynchronous validation and saves, generated wrapper/button markup, dimensions
and modeless draggable/resizable behavior. Native `showModal()` changes modality;
native `show()` does not supply those layout and interaction contracts. The
existing food editor also still needs draggable/droppable/sortable. Porting one
dialog would not remove the widget foundation needed by the other consumers.

Current Chromium/WebKit feature probes find native dialog methods, but
[the browser compatibility data](https://github.com/mdn/browser-compat-data/blob/main/html/elements/dialog.json)
places Safari/iOS dialog support at 15.4, beyond several retained Nightscout
targets. A native-only implementation therefore cannot replace the current
contract; a fallback plus adapters would add another implementation to maintain.
This is a platform/API comparison, not a claim that an unimplemented native
dialog adapter passed all application interactions.

The selected maintained UI implementation already removed the all-in-one
package and unused widgets. Its matched historical app transfer reduction was
34,303 gzip bytes, with an installed-package increase; see the
[UI implementation and regressions](../test-specs/maintained-jquery-ui.md).
Keep its automated focus/keyboard, translated buttons, repeated open/close,
food portions/order/persistence, HMR and cached-navigation coverage. The
[native help-tooltip contracts](../test-specs/help-tooltips.md) remain in CI.
Device/screen-reader testing remains maintainer-owned, not a claimed automated
pass. No additional UI rewrite is scheduled for 15.0.9.

## Flot migration and exposed regressions

Flot 4's default distribution includes unrelated plugins, so the report entry
imports selected source modules through the existing Babel pipeline. The app,
clock, food, profile and admin bundles still contain no Flot/report modules.
The local candle plugin retains its processOptions/drawSeries hook interface.
The package version is authoritative: Flot's internal `$.plot.version` string
in this release still says 3.0.0.

Actual browser tests exposed and now guard these migration differences:

- Hourly candle rendering requires `lines: {show: false}` rather than a boolean.
- Time axes explicitly use milliseconds; the new default is seconds.
- Fixed hourly/percentile/glucose bounds disable automatic scaling so 400/22
  and 400/20 unit-specific limits remain effective.
- Loopalyzer bar widths use `[milliseconds, true]` for absolute width. Leaving
  the legacy number expanded a day to 25,025 hourly ticks and made rendering
  much slower. A one-day/tick-count regression catches that failure.
- The all-zero temp-basal range stays centered at -1/+1 instead of moving the
  zero line to the bottom of a 0/+1 range.
- Legends remain enabled. New SVG labels need report-scoped dark text because
  the dashboard stylesheet sets a white inherited SVG fill. Visible label,
  contrast and legend assertions complement numeric data tests.

Characterized goldens from the unchanged parent cover all plotted series for a
sparse seven-day period, including all five Loopalyzer plots, hourly candles,
percentiles/fillbetween and distribution/daily pies. Both units run twice;
empty periods also render twice without errors or accumulating canvases.
Assertions preserve data, fixed axis bounds, finite ticks, one-day ranges and
visible labels. Source-era bar-width numbers and the new explicit absolute
representation normalize to the same semantic width in the data comparison.
Screenshots of Loopalyzer, hourly and percentile views were inspected against
the parent. Flot 4 has different legend symbols, SVG typography and minor grid
ticks; this is not a claim of pixel-identical output. Pie axes are not displayed.

## Compared with one D3 replacement

`tools/audits/d3-report-pie-candidate.js` prototypes a static distribution pie
using Nightscout's already-loaded D3 namespace. The browser probe compares
mixed, single-bucket and empty inputs against Flot, checks values/angle totals,
escaped legend text and repeated rendering, and records seven timings per
case. The standalone unminified helper is 1,352 bytes / 661 gzip; this is not
an app-bundle saving. It does not implement the full report layout, time axes,
bands, candle hooks or every accessibility contract.

The prototype demonstrates that a single pie can be ported without another
chart package. It does not justify retaining a second report rendering path:
the other Flot consumers still require the existing report bundle. Choose the
tested isolated Flot upgrade for this release; revisit plot removal only with
a cohesive scope and a measured reduction in maintained code/transfer cost.

## Measurements, validation and review trigger

[Raw comparison evidence](../audits/report-widget-comparison.json) separates
bundle transfer, real report-fixture timings, candidate probes and axis/data
outputs. On matched Node 22 builds, reports grow from 170,335 to 190,319 raw
bytes and 50,616 to 56,591 gzip bytes (+5,975). Other entry bytes are unchanged;
all application entries total 381,879 gzip bytes. The reports budget becomes
58,000; the existing 410,000 total budget is unchanged. No server-memory saving
is claimed and historical UI savings are not added to this comparison.

Seven alternating fresh Chromium processes per implementation execute two
renders in each unit. Fixture HTTP loading plus rendering ranges/medians are
115–169 / 132 ms for the parent and 112–151 / 133.5 ms for the candidate.
These are local fixture timings, not CPU-only or production latency. Local
Chromium and WebKit pass the six report cases; current hosted Firefox and the
complete CI/CodeQL/Docker suite remain required before child integration.
The existing browser matrix also records the scoped candidate feature/data
probe on all four jobs; no new environment or external account is required.

Reproduce the measurements with clean built baseline/candidate checkouts:

```sh
python3 tools/audits/report-flot-comparison.py BASELINE CANDIDATE results.json \
  --node /path/to/supported/node
node tools/audits/browser-report-widget-probe.cjs
```

Reassess by 2027-04-30, or earlier when the supported browser policy changes,
a relevant security fix requires another line, or a complete plot/dialog port
demonstrates lower maintenance cost. Rollback restores the Flot manifest/lock,
report entry, axis/bar options and report CSS together. Stored reports, therapy
data, settings and client identity formats are unchanged.
