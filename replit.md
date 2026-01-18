# Nightscout CGM Remote Monitor

## Overview
Nightscout is a web-based Continuous Glucose Monitor (CGM) system designed to allow caregivers to remotely view a patient's glucose data in real-time. The project aims to provide robust, real-time glucose monitoring, data visualization, and alert capabilities, supporting both patient care and clinical research. Key capabilities include multiple API versions for data access, comprehensive data storage, and a plugin-based architecture for extensibility. Future ambitions include enhanced AI agent collaboration through a dedicated control plane, modernized testing frameworks, and advanced authentication mechanisms.

## User Preferences
I want iterative development. Ask before making major architectural changes. Provide detailed explanations for complex technical decisions.

## System Architecture
The Nightscout system is built around a Node.js server with a MongoDB database. It features a modular structure, separating server core, API versions (v1, v2, v3), authorization, plugins, and client-side code.

### UI/UX Decisions
The frontend utilizes Webpack for asset bundling and features charting with D3/jQuery, providing a dynamic dashboard experience.

### Technical Implementations
- **API Versions:**
    - **API v1 (`/api/v1`):** Provides core CGM data, treatments, profiles, and device status. Uses `API_SECRET` for basic authentication.
    - **API v2 (`/api/v2`):** Extends v1 with advanced authorization, including JWT tokens, roles, subjects, and permissions management.
    - **API v3 (`/api/v3`):** A modern REST API based on OpenAPI 3.0, offering comprehensive CRUD operations for collections like entries, treatments, and devicestatus. Swagger UI is available at `/api3-docs`.
- **Authentication:**
    - **API v1:** SHA1 hash of `API_SECRET` in headers or as a query parameter.
    - **API v2/v3:** JWT-based authentication with `Bearer` tokens, managed through an authorization subsystem that defines subjects, roles, and fine-grained permissions (e.g., `api:entries:read`).
- **Real-time Data:** Implemented using Socket.IO for real-time updates on data storage and alarm notifications.
- **Plugin Architecture:** A robust plugin system (e.g., ar2, basal, bolus, cob, iob) allows for extending functionality.
- **Agentic Control Plane (Proposed):** A clean separation between control plane (policy, configuration, intent) and data plane (observations, telemetry, delivery) to facilitate AI agent collaboration with AID systems. This includes JSON schemas for event envelopes, profile definitions, override instances, and delivery requests/observations. Key concepts include event-driven architecture, authority hierarchy (Human > Agent > Controller), and bridge modes for legacy data.
- **Testing & Modernization (Proposed):** A three-track approach for modernizing testing:
    1.  **Testing Foundation:** Update core testing libraries (Mocha, Supertest, NYC) and secure existing tests.
    2.  **Logic/DOM Separation:** Extract pure logic into `lib/client-core/` for isolated, DOM-free testing.
    3.  **UI Modernization Discovery:** Evaluate new UI technologies and define a migration roadmap.
- **Security:** Brute-force protection for authentication is implemented via `delaylist.js` (IP-based progressive delay).
- **MongoDB Driver 5.x Compatibility:** Updates to handle multi-document writes and race conditions, ensuring correct processing of array inputs for `devicestatus` and WebSocket `dbAdd` operations.
- **OIDC Actor Identity (Proposed - High Priority):** OpenID Connect integration to replace freeform `enteredBy` with cryptographically-verified actor identities. Enables care coordination, audit trails, and delegation tracking. See `docs/proposals/oidc-actor-identity-proposal.md` for full RFC including:
    - OAuth2/OIDC protocol flows with NRG Gateway (Ory Hydra/Kratos)
    - JWT claims specification with actor and delegation support
    - Actor lookup collection schema
    - Nightscout Core plugin requirements
    - Migration path from `enteredBy` to verified `actor_ref`
    - Comprehensive test plan (unit/integration/E2E/security)

### System Design Choices
- **Event-driven architecture** for control plane interactions.
- **Append-only event streams** with cursor-based synchronization.
- **Config vs Runtime vs Computed** separation for clarity and maintainability.
- **Monorepo structure** for managing various components.
- **Environment variables** for flexible configuration, including `PORT`, `MONGO_CONNECTION`, `API_SECRET`, and `DISPLAY_UNITS`.

## Data Schema Documentation

New schema documentation has been added based on code analysis and domain expert interviews:

- **`docs/data-schemas/treatments-schema.md`** - Comprehensive documentation of the treatments collection, including:
  - Field inventory (eventType, created_at, glucose, carbs, insulin, etc.)
  - 20+ event types from careportal and controller plugins
  - Timestamp semantics (created_at vs srvCreated)
  - Client compatibility notes (AAPS, Loop, xDrip sync identity patterns)
  - Known bugs (basal slice display, override duration issues)

- **`docs/data-schemas/profiles-schema.md`** - Profile structure documentation including:
  - Store-based profile organization
  - Time-value pair format for basal/carbratio/sens/targets
  - Loop-specific loopSettings and overridePresets
  - Profile switch treatment embedding (AAPS pattern)
  - Timezone handling quirks

Key insights from schema documentation:
- Different controllers use different fields for sync deduplication (AAPS: `identifier`, Loop: pump fields, xDrip: `uuid`)
- The `eventType` field is essentially free-form - controllers can send any value
- Report plugins serve as implicit schema documentation by revealing which fields are actually used

## Documentation Structure

Documentation is organized into purpose-specific folders. Start at `docs/INDEX.md` for navigation.

| Folder | Purpose |
|--------|---------|
| `docs/meta/` | Project-level navigation: architecture overview, modernization roadmap, documentation progress |
| `docs/audits/` | System analysis: API, data layer, security, real-time, plugin, messaging, dashboard audits |
| `docs/requirements/` | Formal requirements by area (shape handling, authorization, API v1 compatibility) |
| `docs/test-specs/` | Test specifications with progress tracking; each area tracks its own gaps |
| `docs/proposals/` | RFC-style proposals for new features (OIDC, control plane, testing modernization) |
| `docs/data-schemas/` | Collection and field documentation (treatments, profiles) |
| `docs/plugins/` | Plugin-specific documentation |

### For AI Agents
Each test area is self-contained with requirements, test specs, progress tracking, and priority gaps. This enables focused iteration on one topical area at a time. See `docs/INDEX.md` for the full taxonomy.

## Test Documentation

Test specifications and requirements are organized in `docs/test-specs/` and `docs/requirements/`. Each test area tracks its own progress, discoveries, and coverage gaps.

### Test Spec Files
| Area | Test Spec | Requirements |
|------|-----------|--------------|
| Shape Handling | `docs/test-specs/shape-handling-tests.md` | `docs/requirements/data-shape-requirements.md` |
| Authorization | `docs/test-specs/authorization-tests.md` | `docs/requirements/authorization-security-requirements.md` |
| API v1 Compatibility | (integrated) | `docs/requirements/api-v1-compatibility-requirements.md` |

### Quick Test Commands
```bash
npm test -- --grep "Shape Handling"
npm test -- --grep "Security"
npm test -- tests/concurrent-writes.test.js
```

### Flaky Test Detection
A flaky test runner is available to identify tests that pass inconsistently:

```bash
npm run test:flaky           # Run 10 iterations (default)
npm run test:flaky:quick     # Run 3 iterations (quick check)
npm run test:flaky:thorough  # Run 20 iterations (thorough analysis)
```

Configuration via environment variables:
- `FLAKY_TEST_ITERATIONS` - Number of test runs (default: 10)
- `FLAKY_TEST_TIMEOUT` - Timeout per run in ms (default: 300000)
- `FLAKY_OUTPUT_DIR` - Output directory (default: ./flaky-test-results)

Reports are generated in `flaky-test-results/` including:
- Markdown report with flaky tests sorted by failure rate
- JSON data file with detailed per-test run history
- Individual iteration JSON results for debugging

See `docs/test-specs/coverage-gaps.md` for aggregated coverage gaps across all areas.

## External Dependencies
- **MongoDB:** Primary database for data storage.
- **Socket.IO:** For real-time data communication.
- **Webpack:** For bundling frontend assets.
- **Nodemon:** For development server auto-restarts.
- **Mocha, Supertest, NYC:** Testing frameworks.
- **Pushover, IFTTT Maker:** Messaging and notification services.
- **Alexa, Google Home:** Integrations for voice assistant interaction.