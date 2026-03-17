# Changelog

All notable changes to cgm-remote-monitor are documented in this file.

## [15.0.7] - 2026-03-XX (Unreleased)

### Added

#### UUID/Identifier Handling (REQ-SYNC-072)
- **Treatments API**: Server now normalizes client sync identities into a unified `identifier` field
  - Loop overrides: UUID in `_id` → extracted to `identifier`
  - Loop carbs/doses: `syncIdentifier` → copied to `identifier`
  - xDrip+: `uuid` → copied to `identifier`
  - AAPS: `identifier` unchanged (already correct)
- **Entries API**: CGM entries with UUID `_id` now handled correctly (GAP-SYNC-045)
- **Deduplication**: Server uses `identifier` for upsert matching when present
- **Benefits**: Re-uploading treatments after app reinstall/cache clear updates existing records

#### Test Infrastructure
- **NODE_ENV=test safety check**: Tests now refuse to run without `NODE_ENV=test`, preventing accidental production database destruction (GAP-SYNC-046)
- New npm scripts: `test:unit`, `test:integration` for faster development cycles
- Comprehensive test suite for UUID handling across v1 and v3 APIs

### Changed

#### Node.js Requirements
- **Minimum**: Node.js 20 LTS (was Node 14/16)
- **Tested**: Node 20, 22, 24
- Updated `engines` field in package.json

#### MongoDB Requirements
- **Minimum**: MongoDB 4.4 (was 4.2)
- **Tested**: MongoDB 4.4, 5.0, 6.0
- Improved compatibility with MongoDB 5.x+ `$set` behavior

### Fixed

- **Loop Override Sync** (Issue #8450): Overrides with UUID `_id` no longer cause duplicate records
- **mmol BG Display**: Fixed OpenAPS tooltips showing incorrect values for mmol/L users
- **AAPS Entry Dedup**: Added retry logic for CI flakiness in concurrent upload tests

### Documentation

- Updated README.md with current Node.js and MongoDB requirements
- Added "Running Tests Locally" section to CONTRIBUTING.md
- Updated treatments schema documentation with identifier normalization behavior

### Security

- Enabled Traditional Chinese localization

---

## [15.0.6] - Previous Release

See GitHub releases for prior changelog entries.
