# Changelog

All notable changes to cgm-remote-monitor are documented in this file.

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
