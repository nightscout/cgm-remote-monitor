# Captured fixtures

Pseudonymized, deterministic, size-bounded slices of real
Nightscout collections, used to drive Node-only unit tests for
`lib/client-core/` modules with realistic modern payload shapes.

## Layout

Fixtures are organized by **uploader source** under per-source subdirectories:

```
tests/fixtures/captured/
├── loop/                # Loop iOS (`loop://iPhone` → `loop://test-device`)
│   ├── entries.json
│   ├── treatments.json
│   ├── devicestatus.json
│   └── profile.json
├── trio/                # Trio (oref1 algorithm; `device='Trio'`)
│   ├── treatments.json
│   └── devicestatus.json
├── aaps/                # AAPS-Android (`device='openaps://AndroidAPS'`)
│   ├── treatments.json
│   └── devicestatus.json
└── phone-uploader/      # xDrip4iOS-style phone uploader (no Loop/openaps body)
    ├── treatments.json
    └── devicestatus.json
```

## Provenance

| Source | Files | Records | Notes |
|---|---|---|---|
| `loop/` | entries, treatments, devicestatus, profile | 288 / 100 / 30 / 10 | Dexcom G6 + Loop iOS; full predicted/IOB/COB/override |
| `trio/` | treatments, devicestatus | 80 / 20 | Trio oref1 with `openaps.suggested.predBGs.{ZT,IOB,COB,UAM}`; SMBs present |
| `phone-uploader/` | treatments, devicestatus | 50 / 30 | Generic phone uploader (xDrip4iOS); devicestatus carries `uploader{battery,type:PHONE}` only — no algorithm body |

All three sets were processed through `tools/captured-fixtures/sanitize.js`.
The `loop/` slice was captured 2026-05-09 from a remote Nightscout
instance; `trio/` and `phone-uploader/` were sliced from
`externals/ns-data/patients/{b,j}/training/`.

## Coverage matrix

| Controller / source | Covered? | Fixture path |
|---|---|---|
| Loop iOS | ✅ | `loop/` |
| Trio (oref1) | ✅ | `trio/` |
| AAPS Android (`device='openaps://AndroidAPS'`) | ✅ | `aaps/` |
| Phone-only uploader (xDrip4iOS) | ✅ | `phone-uploader/` |
| OpenAPS rig (`openaps://edison`) | ❌ gap | — (no source identified) |
| xDrip+ Android entries / pebble fields | ❌ gap | — (no source identified) |
| Medtronic CareLink uploads | ❌ gap | — (no source identified) |

**Absence of a controller here is not evidence of test coverage.**
When new captures land, add them under a new `<source>/` subdir and
register the source in `SOURCES` inside
`tests/client-core/captured-fixtures.lint.test.js`.

## Sanitization rules

Performed by `tools/captured-fixtures/sanitize.js`:

1. **`_id` regenerated** as a deterministic 24-hex-char digest of
   the canonicalized record (sha1 of sorted-keys JSON, truncated).
2. **Device serials scrubbed**: `Dexcom G6 8XRSC5` → `Dexcom G6 SERIAL`.
3. **Phone models scrubbed**: `Sony SO-53B` / `Pixel …` / `SM-…` → `Android Phone`.
4. **Pump IDs scrubbed**: `pump.pumpID` → `'PUMPID'`.
5. **Uploader names scrubbed**: `uploader.name` → `'test-uploader'`,
   `loop://iPhone` → `loop://test-device`.
6. **Loop instance name scrubbed**: `loop.name` → `'TestLoop'`.
7. **Free-text fields dropped**: `notes`, `reason`, `foodType`,
   `userEnteredAt` are removed from treatments entirely.
8. **Push tokens stripped**: `loopSettings.deviceToken` deleted.
9. **Bundle identifier scrubbed**: `loopSettings.bundleIdentifier`
   → `'test.bundle.identifier'`.
10. **Override preset names scrubbed**: `loopSettings.overridePresets[i].name`
    → `'preset-{i+1}'`.
11. **`syncIdentifier` regenerated** deterministically.
12. **`enteredBy` pseudonymized**: `'test-user'` / `'loop://test-device'`.
13. **Timestamps shifted** uniformly so the latest record per source
    lands at `2026-05-09T00:00:00.000Z` (anchor collection: entries
    if present, else devicestatus, else treatments). Intervals and
    time-of-day patterns are preserved.
14. **Top-level keys sorted alphabetically** for canonical diff.

For multi-controller patient dumps (e.g. Trio account that also
relayed Loop records), sanitizer applies a per-label
**device prefilter** (`DS_FILTER_BY_LABEL`) so the slice keeps only
the controller of interest.

## Determinism guarantee

Re-running the sanitizer on the same source dump produces
byte-identical output. `tests/client-core/captured-fixtures.lint.test.js`
enforces no-banned-token + shape + envelope per source.

## Regenerating

```sh
# Loop iOS slice (default label)
node tools/captured-fixtures/sanitize.js \
  --src /path/to/loop/dump \
  --out tests/fixtures/captured/loop --label loop

# Trio slice (filters to device='Trio', enteredBy='Trio')
node tools/captured-fixtures/sanitize.js \
  --src externals/ns-data/patients/b/training \
  --out tests/fixtures/captured/trio --label trio

# Phone-uploader slice (filters out any record carrying loop/openaps/pump body)
node tools/captured-fixtures/sanitize.js \
  --src externals/ns-data/patients/j/training \
  --out tests/fixtures/captured/phone-uploader --label phone-uploader

# AAPS-Android slice (filters to device=openaps://AndroidAPS)
# Source: tools/ns2parquet/fixtures/ in the rag-nightscout-ecosystem-alignment workspace.
node tools/captured-fixtures/sanitize.js \
  --src /tmp/aaps-raw \
  --out tests/fixtures/captured/aaps --label aaps
```

Source dump must contain whichever of `entries.json`, `treatments.json`,
`devicestatus.json`, `profile.json` are relevant; missing files are
treated as empty collections.

## Why these slices and sizes

| Source / file | Limit | Rationale |
|---|---|---|
| loop/entries | 288 | One day of 5-min CGM data — enough for time-of-day, distribution, direction-trend tests. |
| loop/treatments | 100 | Cross-section of Loop-emitted Temp Basals + manual entries. |
| loop/devicestatus | 30 | Each record carries a 60-bin `loop.predicted.values` array (~1.5 KB). |
| loop/profile | 10 | Captures legacy → modern migrations and override-preset variety. |
| trio/devicestatus | 20 | Trio records are ~3 KB each (predBGs arrays). 20 keeps file <100 KB. |
| trio/treatments | 80 | Mix of Temp Basal, SMB, Bolus, Carb Correction, Site Change. |
| aaps/devicestatus | 30 | AAPS records are ~3 KB each (openaps.suggested.reason verbose); 30 keeps file <110 KB. |
| aaps/treatments | 80 | Mix of Temp Basal, SMB, Meal Bolus, Correction Bolus, Temporary Target, BG Check. |
| phone-uploader/devicestatus | 30 | Records are tiny (no algorithm body); 30 spans enough time for staleness checks. |
| phone-uploader/treatments | 50 | xDrip4iOS Carbs / Bolus / BG Check only. |

