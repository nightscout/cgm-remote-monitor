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

## Shape Handling Test Coverage

Comprehensive test coverage for single document vs array input handling across all APIs. See `docs/test-specs/shape-handling-spec.md` for full specification.

### Test Files
| File | Coverage Area |
|------|---------------|
| `tests/api.shape-handling.test.js` | API v1 treatments, devicestatus, entries - single/array input, response shapes |
| `tests/api3.shape-handling.test.js` | API v3 all collections - single object only (arrays rejected) |
| `tests/storage.shape-handling.test.js` | Storage layer direct tests, MongoDB insertOne vs insertMany |
| `tests/websocket.shape-handling.test.js` | WebSocket dbAdd/dbUpdate/dbRemove operations |
| `tests/concurrent-writes.test.js` | Race conditions, concurrent access, MongoDB 5.x compatibility |

### API Behavior Summary
| Interface | Single Object | Array Input | Response Format |
|-----------|---------------|-------------|-----------------|
| API v1 `/api/treatments/` | Supported | Supported | Always Array |
| API v1 `/api/devicestatus/` | Supported | Supported | Always Array |
| API v1 `/api/entries/` | Supported | Supported | Always Array |
| API v3 `/api/v3/{collection}` | Supported | Rejected (400) | Single Object |
| WebSocket `dbAdd` | Supported | Supported | Always Array |

### Running Shape Handling Tests
```bash
npm test -- --grep "Shape Handling"
npm test -- tests/api.shape-handling.test.js
npm test -- tests/concurrent-writes.test.js
```

## External Dependencies
- **MongoDB:** Primary database for data storage.
- **Socket.IO:** For real-time data communication.
- **Webpack:** For bundling frontend assets.
- **Nodemon:** For development server auto-restarts.
- **Mocha, Supertest, NYC:** Testing frameworks.
- **Pushover, IFTTT Maker:** Messaging and notification services.
- **Alexa, Google Home:** Integrations for voice assistant interaction.