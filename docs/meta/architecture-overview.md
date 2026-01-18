# Nightscout Architecture Overview

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Purpose:** System audit and modernization planning

---

## 1. Executive Summary

Nightscout (cgm-remote-monitor) is an open-source, real-time Continuous Glucose Monitoring (CGM) data visualization system. It enables patients and caregivers to remotely monitor blood glucose levels, receive alerts, and track diabetes management data.

### Key Metrics
- **Version:** 15.0.4
- **License:** AGPL-3.0
- **Primary Stack:** Node.js + MongoDB + Socket.IO
- **Node.js Support:** ^14.x, ^16.x, ^18.x, ^20.x (LTS versions)
- **Supported NPM:** ^6.x

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Web Dashboard    │  Pebble Watch   │  Mobile Apps   │  Alexa/Google Home   │
│  (D3.js/jQuery)   │  (/pebble API)  │  (REST/Socket) │  (Voice Assistants)  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TRANSPORT LAYER                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│           HTTP/HTTPS (Express 4.17.1)    │    Socket.IO 4.5.4              │
│           REST API v1/v2/v3              │    /storage, /alarm namespaces  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           APPLICATION LAYER                                  │
├────────────────┬────────────────┬────────────────┬─────────────────────────┤
│  Authorization │   Plugin       │   Notification │      Data               │
│  (JWT/Shiro)   │   System       │   Engine       │      Loader             │
│                │   (30+ plugins)│                │                         │
├────────────────┴────────────────┴────────────────┴─────────────────────────┤
│                          EVENT BUS (lib/bus.js)                             │
│           Stream-based pub/sub: tick, data-update, notification            │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                    MongoDB 3.6+ (via mongodb driver)                        │
│   Collections: entries, treatments, devicestatus, profile, food, activity  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL INTEGRATIONS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Pushover │ IFTTT Maker │ Dexcom Share │ Medtronic CareLink │ Loop/OpenAPS │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Directory Structure

```
nightscout/
├── lib/                          # Core application code
│   ├── server/                   # Server initialization and core services
│   │   ├── server.js            # Entry point
│   │   ├── bootevent.js         # Boot sequence orchestration
│   │   ├── app.js               # Express app configuration
│   │   ├── websocket.js         # Legacy WebSocket handler
│   │   ├── pebble.js            # Pebble watch API
│   │   ├── pushnotify.js        # Push notification orchestration
│   │   └── env.js               # Environment configuration
│   │
│   ├── api/                      # REST API v1 endpoints
│   ├── api2/                     # REST API v2 (authorization extensions)
│   ├── api3/                     # REST API v3 (OpenAPI 3.0 compliant)
│   │   ├── storageSocket.js     # Real-time data broadcast
│   │   ├── alarmSocket.js       # Real-time alarm broadcast
│   │   └── security.js          # API v3 security middleware
│   │
│   ├── authorization/            # Auth system (JWT, Shiro permissions)
│   ├── plugins/                  # 38 plugins (data processing, alarms, etc.)
│   ├── client/                   # Client-side JavaScript modules
│   ├── data/                     # Data loading and processing
│   ├── storage/                  # Database adapters (MongoDB, OpenAPS)
│   ├── report_plugins/           # Report generation plugins
│   ├── middleware/               # Express middleware
│   │
│   ├── bus.js                    # Internal event bus
│   ├── notifications.js          # Notification/alarm management
│   ├── sandbox.js                # Plugin execution sandbox
│   └── settings.js               # Application settings
│
├── bundle/                       # Webpack client bundle source
├── static/                       # Static assets (CSS, JS, images)
├── views/                        # EJS templates and clock views
├── tests/                        # Mocha test suite
├── docs/                         # Documentation
└── webpack/                      # Webpack configuration
```

---

## 4. Core Components

### 4.1 Boot Sequence (`lib/server/bootevent.js`)

The application follows a sequential boot process using the `bootevent` library:

```
startBoot → checkNodeVersion → checkEnv → augmentSettings → checkSettings
     ↓
setupStorage → setupAuthorization → setupInternals → ensureIndexes
     ↓
setupListeners → setupConnect → setupBridge → setupMMConnect → finishBoot
```

**Key Boot Tasks:**
1. **startBoot:** Initialize context (ctx), event bus, admin notifications
2. **setupStorage:** Connect to MongoDB or OpenAPS storage
3. **setupAuthorization:** Load JWT/Shiro authorization system
4. **setupInternals:** Initialize plugins, data loaders, notifications
5. **setupListeners:** Wire up event bus handlers for data processing

### 4.2 Event Bus (`lib/bus.js`)

A lightweight Node.js Stream-based pub/sub system for internal communication.

**Core Events:**
| Event | Trigger | Subscribers |
|-------|---------|-------------|
| `tick` | Heartbeat interval | Data loader, plugins |
| `data-received` | New data ingested | Data loader |
| `data-loaded` | Data refresh complete | Plugin system, sandbox |
| `data-processed` | Plugins finished | Runtime state |
| `notification` | Alert triggered | Push notify, WebSocket |
| `teardown` | Server shutdown | All cleanup handlers |

**Modernization Note:** The Stream-based event bus is functional but dated. Consider migrating to EventEmitter3 or a typed event system for better debugging and TypeScript compatibility.

### 4.3 Plugin System (`lib/plugins/`)

Extensible plugin architecture with 38 plugins for data processing, visualization, and alerting.

**Plugin Types:**
- `pill-primary`: Primary display values (bgnow, rawbg)
- `pill-status`: Status indicators (timeago, upbat)
- `forecast`: Predictive algorithms (ar2)
- `report`: Historical analysis (dailystats, glucosedistribution)
- `notification`: Alert generators (simplealarms, treatmentnotify)

**Plugin Lifecycle:**
1. Registration during boot
2. `setProperties()`: Calculate derived values
3. `checkNotifications()`: Generate alerts
4. `updateVisualisation()`: Update UI elements

### 4.4 Data Flow

```
CGM Device → Uploader → REST API → MongoDB → Data Loader
                                       ↓
                              Plugin Processing
                                       ↓
                              Event Bus (data-processed)
                                       ↓
                    ┌──────────────────┴──────────────────┐
                    ↓                                      ↓
            WebSocket Broadcast                    Push Notifications
            (Dashboard Update)                     (Pushover/IFTTT)
```

---

## 5. Technology Stack

### 5.1 Backend Dependencies

| Package | Version | Purpose | Modernization Notes |
|---------|---------|---------|---------------------|
| express | 4.17.1 | Web framework | Update to 4.18+ or 5.x |
| mongodb | ^3.6.0 | Database driver | Update to 4.x+ for better types |
| socket.io | ~4.5.4 | Real-time comms | Current (good) |
| jsonwebtoken | ^9.0.0 | JWT handling | Current (good) |
| shiro-trie | ^0.4.9 | Permission model | Unique, consider alternatives |
| moment | ^2.27.0 | Date handling | Consider dayjs or Temporal |
| lodash | ^4.17.20 | Utilities | Current, consider tree-shaking |
| request | ^2.88.2 | HTTP client | **DEPRECATED** - migrate to axios |

### 5.2 Frontend Dependencies

| Package | Version | Purpose | Modernization Notes |
|---------|---------|---------|---------------------|
| jquery | ^3.5.1 | DOM manipulation | Consider modern alternatives |
| d3 | ^5.16.0 | Data visualization | Update to D3 v7 |
| flot | ^0.8.3 | Legacy charting | Consider Chart.js or D3-only |
| webpack | ^5.74.0 | Bundling | Current (good) |

### 5.3 External Integrations

| Integration | Purpose | Notes |
|-------------|---------|-------|
| Pushover | Push notifications | Paid service, callback support |
| IFTTT Maker | Webhook automation | Event-based triggers |
| Dexcom Share | CGM data bridge | Deprecated in favor of nightscout-connect |
| Medtronic CareLink | CGM data bridge | Deprecated in favor of nightscout-connect |
| Alexa | Voice assistant | Custom skill support |
| Google Home | Voice assistant | Custom actions support |

---

## 6. API Versioning

### 6.1 API Version Summary

| Version | Base Path | Auth Method | Status |
|---------|-----------|-------------|--------|
| v1 | `/api/v1` | API_SECRET header/query | Legacy, widely used |
| v2 | `/api/v2` | JWT tokens | Current default |
| v3 | `/api/v3` | JWT tokens, OpenAPI 3.0 | Modern, recommended |

### 6.2 Endpoint Categories

**v1 Endpoints:**
- `/entries` - Glucose readings (SGV data)
- `/treatments` - Treatment events (insulin, carbs, notes)
- `/profile` - User profiles and settings
- `/devicestatus` - Device/loop status
- `/food` - Food database
- `/status` - Server status

**v2 Extensions:**
- `/authorization` - Token management
- `/properties` - System properties
- `/ddata` - Aggregated data endpoint

**v3 Generic Collections:**
- `/{collection}` - CRUD for all collections
- `/{collection}/history/{lastModified}` - Incremental sync
- `/version`, `/status`, `/lastModified` - Metadata

---

## 7. Real-Time Communication

### 7.1 Socket.IO Namespaces

| Namespace | Purpose | Auth Required |
|-----------|---------|---------------|
| `/` (default) | Legacy data updates | API_SECRET or token |
| `/storage` | Collection CRUD events | accessToken |
| `/alarm` | Alarm/announcement broadcast | accessToken |

### 7.2 Event Types

**Storage Events:**
- `create` - Document created
- `update` - Document modified
- `delete` - Document removed

**Alarm Events:**
- `announcement` - User announcement
- `alarm` - Standard alarm (WARN level)
- `urgent_alarm` - Urgent alarm (URGENT level)
- `clear_alarm` - Alarm cleared

---

## 8. Security Architecture

### 8.1 Authentication Methods

**Current:**
1. **API_SECRET:** SHA-1 hash comparison for admin access
2. **Access Tokens:** Pre-shared tokens for subjects
3. **JWT:** Signed tokens with expiration

**Planned (OIDC/OAuth2 Plugin):**
4. **OIDC/OAuth2:** Vendor-agnostic identity via external providers
   - Integration with Ory Hydra/Kratos for consent management
   - nightscout-roles-gateway for delegation and data rights
   - Claims mapped to Shiro permissions
   - Verified actor identity for all data mutations
   - See [OIDC Actor Identity Proposal](./proposals/oidc-actor-identity-proposal.md) for implementation details

### 8.2 Authorization Model

Uses Apache Shiro-style permissions:
```
api:entries:read        # Read entries collection
api:treatments:create   # Create treatments
*                       # Admin (all permissions)
```

**Permission Hierarchy:**
```
Subject → Roles → Permissions → Shiro Trie (check access)
```

**Authority Model (Control Plane RFC):**
```
Human > Agent > Controller
```

### 8.3 Brute-Force Protection

**Location:** `lib/authorization/delaylist.js`

IP-based progressive delay for failed authentication attempts:
- Configurable delay via `authFailDelay` setting (default 5000ms)
- Cumulative delays per IP address
- Auto-clears after 60 seconds of inactivity

**Note:** General API rate limiting is not currently implemented.

---

## 9. Known Architecture Issues

### 9.1 Technical Debt

| Issue | Severity | Location | Recommendation |
|-------|----------|----------|----------------|
| Deprecated `request` library | High | Multiple files | Migrate to axios |
| Legacy callback patterns | Medium | Storage, auth | Async/await refactor |
| jQuery DOM manipulation | Medium | Client code | Modern framework |
| Mixed CommonJS/ES modules | Low | Bundle | Standardize on ES modules |
| Moment.js bundle size | Low | Client bundle | Replace with dayjs |
| Inconsistent error handling | Medium | API layers | Unified error middleware |

### 9.2 Scalability Concerns

1. **Single-threaded:** No clustering support out of box
2. **In-memory state:** Notifications, alarms stored in memory
3. **Poll-based updates:** Heartbeat-driven data loading
4. **Large client bundle:** ~1MB+ JavaScript payload

### 9.3 Maintainability Challenges

1. **No TypeScript:** Pure JavaScript with JSDoc
2. **Tight coupling:** Plugins tightly coupled to sandbox
3. **Global state:** Extensive use of shared `ctx` object
4. **Test coverage:** Limited automated testing

---

## 10. Modernization Recommendations

### 10.1 Security Foundation (Low Effort)

1. Replace deprecated `request` library with axios
2. Add general API rate limiting (express-rate-limit)
3. Add input validation middleware (Zod/Joi)
4. Implement structured logging (pino)

### 10.2 Developer Experience (Medium Effort)

1. Add TypeScript definitions for core modules
2. Convert callbacks to async/await
3. Implement database migrations (instead of ensureIndexes)
4. Expand test coverage

### 10.3 Authentication Modernization (Medium Effort)

1. **OIDC/OAuth2 Plugin:** Vendor-agnostic identity integration
   - See [OIDC Actor Identity Proposal](./proposals/oidc-actor-identity-proposal.md) for full RFC
2. **nightscout-roles-gateway:** Consent and delegation management
3. **Ory Hydra/Kratos:** Identity backend for multi-user deployments
4. **Actor Identity:** Replace freeform `enteredBy` with verified actor claims
5. Maintain backward compatibility with API_SECRET auth

### 10.4 UI Modernization (High Effort)

1. Bundle optimization (replace Moment.js, tree-shake lodash)
2. PWA support (service worker, manifest)
3. Migrate jQuery to vanilla JS or modern framework
4. Accessibility improvements

---

## 11. Related Documents

- [Security Audit](../audits/security-audit.md)
- [API Layer Audit](../audits/api-layer-audit.md)
- [Data Layer Audit](../audits/data-layer-audit.md)
- [Real-Time Systems Audit](../audits/realtime-systems-audit.md)
- [Plugin Architecture Audit](../audits/plugin-architecture-audit.md)
- [Dashboard UI Audit](../audits/dashboard-ui-audit.md)
- [Messaging Subsystem Audit](../audits/messaging-subsystem-audit.md)
- [Modernization Roadmap](./modernization-roadmap.md)
