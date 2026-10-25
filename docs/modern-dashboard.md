# Modern dashboard (opt in)

The modern dashboard is an optional presentation of the existing Nightscout main screen, built from master 15.0.9. Enable it on your server with:

```sh
THEME=modern
```

Restart Nightscout and reload the page. Remove this variable or select an existing theme (`default`, `colors`, or `colorblindfriendly`) and restart to return to the established interface. The default theme remains unchanged. There is no database migration.

The existing browser theme preference takes precedence over the server default, just as it does for the other themes. Select **Modern** in Settings or **Reset, and use defaults** if this browser has a saved preference. Switching back to another theme in Settings restores the classic layout on reload. Both layouts and their chart rendering always follow the same effective theme.

`modern` uses Nightscout's existing coloured glucose thresholds: green in range, yellow outside target, red urgent. It does not change units, thresholds, plugin visibility, alarm configuration, or permissions. Reports, clock views, and editors keep their existing layouts.

## Screen sizes

- **Desktop:** clock and glucose are side by side; plugin pills wrap below; the chart uses the remaining viewport height with a readable minimum.
- **Tablet:** the same hierarchy adapts to the narrower columns; pills wrap naturally without truncating values.
- **Phone (600 CSS pixels or narrower):** a small clock and the existing reading-age pill appear first, followed by the large glucose reading and major pills. The chart appears before a two-column grid of secondary plugin pills. The page scrolls vertically rather than compressing the chart. Every time-range option remains available, and the range control can wrap on narrow screens.

The original plugin elements and their tooltips are retained. Pills reflect real plugin warning/urgent state; the design never invents a connection or health status. Existing alarm colours, alarm menus, stale-reading strike-through, historical browsing, treatment entry, settings, and authorization still use Nightscout's normal client code. Browser text zoom is allowed. Controls have keyboard focus indicators; chart range and glucose/alarm controls accept Enter or Space.

## Chart meaning

The modern trace joins consecutive **sensor readings** with straight segments and keeps the original sample dots and tooltips. It never smooths the data or joins finger-stick/raw-glucose points into the sensor trace. A larger dot identifies the latest sensor reading. Colour comes from Nightscout's existing colour function.

Missing and invalid sensor readings break the trace. The renderer infers the sampling cadence from recent data intervals and breaks intervals greater than 1.5 times that cadence, with an absolute limit of 7.5 minutes. Thus a missing sample in a regular 1-minute or 5-minute feed remains visible. Sensor error codes are not joined. Individual readings remain present even when there are too few points to form a line.

Forecasts are dashed and separated by provider, forecast type, branch, and colour. AR2's upper and lower cone branches are identified explicitly so the renderer cannot zigzag between them. This adds display metadata only; it does not change prediction calculations or values. Forecast samples retain transparent hover/touch targets for the existing tooltips. The target band uses the configured thresholds, and axes retain the selected scale and units.

The overview retains its brush and sample shading. Paths are clipped to the plot, and are redrawn when data, history range, units, or container dimensions change. Classic rendering stays dot-only.
