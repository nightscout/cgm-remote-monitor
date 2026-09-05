# Changelog

All notable changes to cgm-remote-monitor are documented in this file.

## [Unreleased]

### Fixed

- **Dependency security:** Update all `brace-expansion` copies to the latest
  compatible releases (1.1.18, 2.1.4 and 5.0.9), including nested tooling
  dependencies. Keep overrides scoped by major version because older
  `minimatch` consumers require the function export from 1.x/2.x; 5.x uses a
  named `expand` export. CI checks dependency resolution, normal glob matching
  and resource limits to prevent vulnerable or incompatible copies returning.
- **Daily Stats estimated A1c:** Calculate both estimates from the original
  mg/dL readings, correcting inflated results in mg/dL mode. A mean glucose of
  150 mg/dL now displays 6.9% (DCCT) and 51 mmol/mol (IFCC). Switching glucose
  display units gives the same estimates; mmol/L results can change slightly
  because the calculation no longer uses rounded display values.
- **Reports (#8588):** Closely spaced CGM readings no longer cause later valid
  readings to be discarded in a chain. The one-minute filter now compares each
  reading with the last retained reading. Regenerating reports from the same
  historical data may show more readings and different charts, averages and
  range percentages. Five-minute series are unaffected. Range percentages
  continue to count retained readings rather than weight elapsed time.

## [15.0.7] - 2026-03-XX (Unreleased)

### Added

#### UUID/Identifier Handling (REQ-SYNC-072)

- **`UUID_HANDLING` env var** (default: `true`): Feature flag that controls UUID `_id` normalization for treatments and entries.
  - When `true`: UUID values sent as `_id` are extracted to the `identifier` field and a server-generated ObjectId is assigned. GET/DELETE by UUID are routed through the `identifier` field.
  - When `false`: UUID `_id` values are stripped (UUID identity not preserved) and UUID-based queries return empty results.
- **Treatments API**: Loop overrides with UUID `_id` are now normalized correctly, preventing duplicate records (Issue #8450).
- **Entries API**: CGM entries (e.g., Trio) with UUID `_id` are now handled correctly.
- **Scope**: Only UUID values in the `_id` field are affected. Other client identity fields (`syncIdentifier`, `uuid`, `identifier`) are preserved but not modified.

#### Test Infrastructure

- **NODE_ENV=test safety check**: Tests now refuse to run without `NODE_ENV=test`, preventing accidental production database modification.
- Comprehensive test suite for UUID handling behavior across write and read paths.

### Documentation

- Updated README.md with `UUID_HANDLING` and MongoDB pool configuration env vars.
- Added entries schema documentation (`docs/data-schemas/entries-schema.md`).
- Updated treatments schema documentation with identifier normalization behavior.
- Added test environment variables reference to CONTRIBUTING.md.

---

## [15.0.6] - Previous Release

See GitHub releases for prior changelog entries.
