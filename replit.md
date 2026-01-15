# Nightscout CGM Remote Monitor

## Overview
Nightscout is a web-based CGM (Continuous Glucose Monitor) system allowing caregivers to remotely view a patient's glucose data in realtime. Version 15.0.4 of the cgm-remote-monitor project.

## Current State
- Running on Replit with MongoDB local development database
- Server on port 5000 (0.0.0.0)
- Webpack bundling for frontend assets
- Three API versions available (v1, v2, v3)

## Project Structure
```
lib/
├── server/           # Server core (server.js, app.js, env.js)
├── api/              # REST API v1
├── api2/             # REST API v2 (extends v1 + authorization)
├── api3/             # REST API v3 (modern, OpenAPI 3.0)
├── authorization/    # JWT auth, roles, subjects, permissions
├── plugins/          # Feature plugins (ar2, basal, bolus, cob, iob, etc.)
├── storage/          # MongoDB storage adapters
├── client/           # Client-side code
├── data/             # Data loading and processing
└── report_plugins/   # Report generation

static/               # Frontend HTML, CSS, JS, assets
bundle/               # Webpack bundle sources
webpack/              # Webpack configuration
docs/                 # Plugin documentation
start.sh              # Startup script (MongoDB + app)
```

## API Endpoints

### API v1 (`/api/v1`)
| Endpoint | Description |
|----------|-------------|
| `/entries/*` | CGM entries (sgv, mbg, cal) |
| `/treatments/*` | Treatment records |
| `/profile/*` | User profiles |
| `/devicestatus/*` | Device status |
| `/food/*` | Food database |
| `/activity/*` | Activity records |
| `/notifications/*` | Notifications |
| `/status/*` | Server status |
| `/alexa/*` | Alexa integration |
| `/googlehome/*` | Google Home integration |

### API v2 (`/api/v2`)
Extends v1 with:
| Endpoint | Description |
|----------|-------------|
| `/authorization/request/{token}` | Get JWT token |
| `/authorization/subjects` | Manage subjects (CRUD) |
| `/authorization/roles` | Manage roles (CRUD) |
| `/authorization/permissions` | List permissions |
| `/properties` | System properties |
| `/ddata` | Data endpoints |
| `/summary` | Summary data |

### API v3 (`/api/v3`)
Modern REST API with OpenAPI 3.0 spec.

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/{collection}` | GET, POST | Search/create documents |
| `/{collection}/{id}` | GET, PUT, PATCH, DELETE | CRUD by identifier |
| `/{collection}/history/{lastModified}` | GET | Changes since timestamp |
| `/version` | GET | API version |
| `/status` | GET | API status |
| `/lastModified` | GET | Last modification times |

**Collections:** entries, treatments, devicestatus, food, profile, settings

**Swagger UI:** Available at `/api3-docs`

## Authentication

### API v1
- `API_SECRET` as SHA1 hash in header: `api-secret: <sha1-hash>`
- Or token parameter: `?token=<sha1-hash>`

### API v2/v3 (JWT)
1. Create subjects/roles in Admin Tools
2. Get JWT: `GET /api/v2/authorization/request/{accessToken}`
3. Use in header: `Authorization: Bearer <jwt>`

**Permissions format:** `api:<collection>:<action>`
- Examples: `api:entries:read`, `api:treatments:create`, `api:*:*`

## Real-time Data (Socket.IO)

| Namespace | Purpose | Auth |
|-----------|---------|------|
| `/storage` | Data updates for collections | accessToken required |
| `/alarm` | Alarm notifications | accessToken required |

## OpenAPI Specifications
| File | Version |
|------|---------|
| `lib/server/swagger.yaml` | API v1 (14.2.3) |
| `lib/api3/swagger.yaml` | API v3 (3.0.4) |

## Environment Variables

### Core
| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 1337 |
| `HOSTNAME` | Bind address | null |
| `MONGO_CONNECTION` | MongoDB URI | - |
| `API_SECRET` | Auth secret (min 12 chars) | - |
| `INSECURE_USE_HTTP` | Allow HTTP (for proxies) | false |

### API v3
| Variable | Description | Default |
|----------|-------------|---------|
| `API3_SECURITY_ENABLE` | Enable auth | true |
| `API3_MAX_LIMIT` | Max docs per query | 1000 |
| `API3_DEDUP_FALLBACK_ENABLED` | Dedup for legacy docs | true |

### Display
| Variable | Description | Default |
|----------|-------------|---------|
| `DISPLAY_UNITS` | mg/dl or mmol | mg/dl |
| `ENABLE` | Enabled plugins | - |

## Replit Configuration
- `PORT=5000`, `HOSTNAME=0.0.0.0`
- `INSECURE_USE_HTTP=true` (required for Replit proxy)
- MongoDB at `mongodb://localhost:27017/nightscout`
- Data stored in `/home/runner/data/db`

## NPM Scripts
| Script | Description |
|--------|-------------|
| `npm start` | Production server |
| `npm run bundle` | Webpack build |
| `npm run dev` | Dev server with nodemon |
| `npm test` | Run tests |

## Security Documentation
- `lib/api3/doc/security.md` - Auth model
- `lib/api3/doc/socket.md` - Storage socket
- `lib/api3/doc/alarmsockets.md` - Alarm socket
- `lib/api3/doc/tutorial.md` - API tutorial

## Agentic Control Plane Proposal (RFC)

A proposal for extending Nightscout with a clean separation between control plane (policy, configuration, intent) and data plane (observations, telemetry, delivery) to enable AI agent collaboration with AID systems.

### Proposal Documentation
| Document | Description |
|----------|-------------|
| `docs/proposals/agent-control-plane-rfc.md` | Main RFC document with full architecture |
| `docs/proposals/integration-questionnaire.md` | Questions for Loop/AAPS/Trio implementers |
| `docs/proposals/bridge-rules.md` | Legacy devicestatus → event synthesis rules |
| `docs/proposals/conflict-resolution.md` | Multi-writer semantics and authority model |

### JSON Schemas (draft-2020-12)
Located in `docs/proposals/schemas/`:

| Schema | Purpose |
|--------|---------|
| `event-envelope.schema.json` | Wrapper for all control plane events |
| `profile-definition.schema.json` | User-authored profile configuration |
| `profile-selection.schema.json` | Profile activation events |
| `override-definition.schema.json` | Reusable override templates |
| `override-instance.schema.json` | Concrete override activations |
| `policy-composition.schema.json` | Materialized effective parameters |
| `delivery-request.schema.json` | Intent to deliver insulin |
| `delivery-observation.schema.json` | Confirmed delivery records |
| `reconciliation.schema.json` | Request/observation matching |
| `controller-kind-definition.schema.json` | Controller type capabilities |
| `controller-instance-registration.schema.json` | Controller instance registry |
| `capability-snapshot.schema.json` | Real-time controller state |

### Key Concepts
- **Config vs Runtime vs Computed** - Separate user-authored config from runtime activations from computed state
- **Events over Snapshots** - Append-only event streams with cursor-based sync
- **Authority Hierarchy** - Human > Agent > Controller for conflict resolution
- **Bridge Mode** - Synthesize events from legacy devicestatus uploads
- **MDI as First-Class** - Manual injections are always valid

## Testing & Architecture Modernization Proposal

A revised proposal aligning test modernization with broader UI and architecture goals.

| Document | Description |
|----------|-------------|
| `docs/proposals/testing-modernization-proposal.md` | Three-track modernization plan with scope guardrails |

### Three-Track Approach
- **Track 1 (2 weeks):** Testing Foundation - Update mocha/supertest/nyc, migrate hashauth tests with secure jsdom harness
- **Track 2 (3 weeks):** Logic/DOM Separation - Extract pure logic to `lib/client-core/` for fast, DOM-free testing
- **Track 3 (4 weeks):** UI Modernization Discovery - Technology evaluation, server-side stats API contracts, migration roadmap

### Key Decisions
- Keep hashauth tests (security-critical)
- Skip/defer other client tests (UI code may be rewritten)
- Unified Mocha test runner (no Jest migration needed)
- Strict network isolation in test harness (NoNetworkLoader pattern)

### Scope Guardrails
- Milestone exit reviews before proceeding
- Out-of-scope items logged and deferred
- No new UI module without test strategy

## Comprehensive System Audit Documentation

A complete audit of the Nightscout codebase covering all major subsystems, created to support system understanding and modernization planning.

### Audit Documents
Located in `docs/`:

| Document | Description |
|----------|-------------|
| `architecture-overview.md` | System diagram, component relationships, data flow, tech stack |
| `security-audit.md` | Auth mechanisms, JWT, Shiro permissions, brute-force protection (delaylist.js) |
| `api-layer-audit.md` | REST v1/v2/v3 contracts, endpoint inventory, WebSocket protocols |
| `data-layer-audit.md` | MongoDB collections, schemas, auto-pruning, sync mechanisms |
| `realtime-systems-audit.md` | Socket.IO namespaces, event bus patterns, latency analysis |
| `plugin-architecture-audit.md` | Plugin system design, 38 plugins inventory, Pebble integration |
| `dashboard-ui-audit.md` | Client bundle structure, D3/jQuery charting, clock displays |
| `messaging-subsystem-audit.md` | Pushover, IFTTT Maker, notification flows, acknowledgment |
| `modernization-roadmap.md` | Technical debt inventory, phased refactoring plan |

### Critical Findings
- **Auth Brute-Force Protection** - Implemented via `delaylist.js` (IP-based progressive delay)
- **General API Rate Limiting** - Not implemented, recommended for DoS protection
- **Deprecated Dependencies** - `request` library should be replaced with `axios`
- **Bundle Size** - ~1MB+ production bundle, optimization opportunities exist
- **Node.js Support** - Supports ^14.x, ^16.x, ^18.x, ^20.x

### Authentication Modernization Direction
- OIDC/OAuth2 plugin for vendor-agnostic identity
- nightscout-roles-gateway integration for consent and delegation
- Ory Hydra/Kratos as identity backend option
- Aligns with Control Plane RFC authority model (Human > Agent > Controller)

## MongoDB Driver 5.x Migration Testing (PR #8314)

### Critical Findings - Multi-Document Write Support

**Test Suite:** `tests/api.shape-handling.test.js`, `tests/websocket.shape-handling.test.js`, `tests/storage.shape-handling.test.js`

#### Issue 1: devicestatus.js Race Condition (FIXED)
- **Problem:** `create()` function had a closure variable capture bug in async for-loop causing data loss with array inputs
- **Root Cause:** Loop variable captured by reference in callback, race condition between iterations
- **Fix:** Refactored to use `async.eachSeries()` for sequential processing
- **File:** `lib/server/devicestatus.js`

#### Issue 2: WebSocket dbAdd Array Handling (FIXED)
- **Problem:** `insertOne()` with array creates single document containing the array, NOT multiple documents
- **Root Cause:** MongoDB driver behavior - `insertOne([a,b])` stores `{0: a, 1: b}` as one document
- **Fix:** Added `processSingleDbAdd()` helper that iterates array items and processes each sequentially
- **File:** `lib/server/websocket.js`

### Shape Handling Behavior Matrix

| Interface | Single Object | Array Input | Status |
|-----------|---------------|-------------|--------|
| REST API v1 treatments | ✅ | ✅ | Works correctly |
| REST API v1 entries | ✅ | ✅ | Works correctly |
| REST API v1 devicestatus | ✅ | ✅ | Fixed (was race condition) |
| WebSocket dbAdd | ✅ | ✅ | Fixed (was insertOne issue) |
| Storage treatments.create | ✅ | ✅ | Works correctly |
| Storage devicestatus.create | ✅ | ✅ | Fixed |
| Storage entries.create | ✅ | ✅ | Works correctly |
| Storage activity.create | ❌ | ✅ | Expects array only |

### Test Results
- 38 passing tests documenting all shape handling behaviors
- Tests cover API v1, WebSocket storage namespace, and direct storage layer

### Key Implementation Details
- UPDATE_THROTTLE (15 seconds) in `bootevent.js` intentionally debounces data updates
- AAPS/Loop clients may send batch arrays via WebSocket - now properly supported
- All changes preserve backward compatibility with single-object inputs

## Recent Changes
- 2026-01-15: Fixed devicestatus.js race condition and WebSocket array handling for MongoDB 5.x compatibility
- 2026-01-15: Added comprehensive shape-handling test suite (38 tests) for multi-document write validation
- 2026-01-13: Updated audit docs with accurate rate limiting info (delaylist.js) and OIDC/gateway architecture direction
- 2026-01-13: Created comprehensive 9-document system audit with security findings and modernization roadmap
- 2026-01-13: Revised Testing Modernization Proposal with three-track approach, Logic/DOM separation, and UI Discovery track
- 2026-01-01: Added Agentic Control Plane RFC and JSON schemas
- 2025-12-31: Updated to version 15.0.4 (dev branch)
- Configured for Replit with INSECURE_USE_HTTP=true
- MongoDB 3.6.x driver
- Webpack bundling for frontend
