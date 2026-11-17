# D3 browser surface

M14 keeps D3 7.9.0 installed and narrows what webpack exposes to browser code. `lib/d3.mjs` exports the chart/report APIs consumed by this repository, plus color/interpolation contracts and transition initialization. The app entry and four fallback consumers share this facade, avoiding a second full D3 namespace in the bundle.

The facade exports arc, area, axisBottom, axisLeft, axisRight, brushSelection, brushX, color, curveStepAfter, drag, extent, format, interpolateRgb, line, max, pie, pointer, scaleLinear, scaleLog, scaleOrdinal, scaleTime, select, selectAll, timeDay, timeFormat, timeFormatLocale, timeHour, timeMinute, timeMonth, timeSecond, timeWeek, timeYear and transition. Exporting transition keeps selection.transition and selection.interrupt initialized. Plugins that need another D3 API must explicitly add and test that export or supply their own dependency; `window.d3` is no longer the entire upstream namespace. Repository chart/report plugins retain their consumed APIs.

## Regression gates

- `tests/dependency-d3-surface.test.js` parses application source and checks every static D3 access against the facade. Dynamic accesses require explicit review. It also checks the production source map excludes the twelve removed D3 subsystems, catching accidental full-namespace imports. An artifact-only facade with brushX removed fails at the actual chart consumer.
- Existing pure D3 tests retain color/interpolation and bounded pathological-input protection.
- Five `tests/browser/d3-surface.test.js` cases exercise the actual production bundle: color/interpolation/pathological input; two transition completion/interruption cycles; local day offsets and time scales across spring/autumn DST in Los Angeles and London, plus UTC.
- Existing chart browser tests exercise hover, drag, brushing, touch and glucose/forecast output in both units. Existing report tests cover chart/statistics outputs, plugin execution and repeated reconnection. The required Chromium/Firefox/WebKit matrix runs all browser cases on both Node floors.
- The real HTTP development fixture builds and serves the unminified bundle; native asset browser tests cover hot updates and page cascade behavior.

## Measurements against M13

| Production artifact | Parent bytes | Candidate bytes |
| --- | ---: | ---: |
| App JavaScript | 1,672,415 | 1,396,844 |
| App gzip (Python gzip level 9) | 471,312 | 401,222 |

This removes 275,571 raw bytes and 70,090 gzip bytes. The clock bundle is byte-identical. The manifest and lockfile are unchanged: no package-count or installed-size reduction is claimed in this slice. Server heap and populated-dashboard memory were not measured.

Final webpack statistics were captured in a separate output directory; its app bytes match the ordinary production build. The emitted source map reduces represented D3 packages from 30 to 18. Chord, contour, delaunay, dsv, fetch, force, geo, hierarchy, polygon, quadtree, random and scale-chromatic no longer appear. Selection/transition and brush/drag dependencies remain. A represented source is not a claim that every export in that package is emitted.

No intended change to built-in UI, stored data or configuration. Custom scripts using other upstream properties of `window.d3` need the explicit export migration described above. Rollback restores the five import sites to the full D3 namespace; manifests need no change. All required hosted checks must pass before the child merges into modernization.
