# Changelog

All notable changes to cgm-remote-monitor are documented in this file.

## [Unreleased]

### Fixed

- **MongoDB proxy dependency:** Update ip-address to 10.7.0. Add regression
  coverage for IPv4/IPv6 conversion, malformed addresses and SOCKS5 connections
  through MongoDB's installed proxy client. No MongoDB configuration or UI
  changes are required.
- **Build dependency security:** Update fast-uri to 3.1.7, the latest release
  supported by the installed Ajv 8 consumers. Add CI coverage for malformed
  authorities, safe serialization and schema-reference resolution. Keep 3.x
  compatibility; fast-uri 4 changes Unicode encoding and removes deprecated
  types. No Nightscout configuration or UI changes are required.
- **Socket.IO parser:** Update the server and Node client parser to 4.2.7.
  Honor `toJSON()` when encoding binary packets and reject malformed binary
  packets with zero attachments. Add CI coverage for live updates, binary
  acknowledgements and reconnects over polling and WebSocket, including the
  browser client served to Nightscout pages. No configuration changes required.
- **Sanitizer test reference:** Update the development-only DOMPurify dependency
  to 3.4.14. Add regression coverage for nested template sanitization, note text
  and SVG presentation attributes. Production sanitization still uses
  `sanitize-html`; stored data and UI behavior are unchanged.
- **YAML dependency security:** Update js-yaml to the latest compatible 3.15.2
  and 4.3.2 releases. Preserve the APIs used by ESLint, nyc and Mocha while
  adding merge-work limits and the ordered-map CPU fix. CI checks YAML
  configuration loading and the development webpack/ESLint integration.
  Production dependencies are unchanged; see CONTRIBUTING.md for custom
  tooling YAML configuration limits.
- **Test tooling:** Update Mocha to 11.8.0, the latest 11.x release, preserving
  the existing Node.js compatibility range. Mocha 12 requires newer Node.js
  versions and a separate runner migration review. Add CI coverage for serial
  and parallel execution, root hooks, timeout handling and failure reporting.
  Nano ID remains at the latest compatible 3.3.18 release for PostCSS; no
  production dependencies or Nightscout configuration change.
- **PostCSS:** Update to 8.5.28 and its required Nano ID 3.3.18 dependency.
  This includes CSS parsing fixes and tighter restrictions on loading source
  maps referenced by CSS. CI now checks stylesheet output, source-map
  boundaries and sanitizer compatibility. No Nightscout configuration changes
  are required.
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
