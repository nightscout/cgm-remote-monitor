# Modernization Roadmap

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Purpose:** Technical debt inventory, refactoring priorities, architecture improvements, migration strategies

---

## 1. Executive Summary

This roadmap outlines a phased approach to modernizing the Nightscout codebase while maintaining stability for the existing user base. The focus is on improving accuracy, velocity (development speed), and maintainability.

### Modernization Principles

1. **Backward Compatibility:** Maintain API compatibility during transitions
2. **Incremental Progress:** Small, testable changes over big rewrites
3. **User Safety First:** Health-critical application - no regressions
4. **Community Involvement:** Open source project requires consensus

---

## 2. Technical Debt Inventory

### 2.1 Critical Debt (Immediate Action Required)

| Item | Location | Risk | Effort |
|------|----------|------|--------|
| Deprecated `request` library | Multiple files | Security | Medium |
| No input validation | API endpoints | Security | High |
| No rate limiting | Server | DoS vulnerability | Medium |
| Outdated Node.js support | package.json | Security | Low |

### 2.2 High Priority Debt

| Item | Location | Impact | Effort |
|------|----------|--------|--------|
| Callback-based async code | Throughout | Maintainability | High |
| No TypeScript | Throughout | Developer velocity | Very High |
| Global state (ctx object) | Server code | Testability | High |
| jQuery dependency | Client | Bundle size, modernization | High |
| Moment.js bundle size | Client | Performance | Low |

### 2.3 Medium Priority Debt

| Item | Location | Impact | Effort |
|------|----------|--------|--------|
| No database migrations | Storage | Operations | Medium |
| Inconsistent error handling | API layers | Debugging | Medium |
| Missing test coverage | Throughout | Quality | High |
| No structured logging | Server | Observability | Medium |
| Mixed module systems | Throughout | Build complexity | Medium |

### 2.4 Low Priority Debt

| Item | Location | Impact | Effort |
|------|----------|--------|--------|
| D3.js v5 (outdated) | Client | Features | Medium |
| Flot charts (legacy) | Reports | Maintainability | Medium |
| Manual DOM updates | Client | Complexity | High |
| No service worker | Client | Offline/PWA | Medium |

---

## 3. Phased Modernization Plan

### Phase 1: Security Foundation

**Goal:** Address critical security issues and establish modern tooling  
**Effort:** Low to Medium | **Complexity:** Straightforward

#### 3.1.1 Replace Deprecated Dependencies

**Action:** Replace `request` library with `axios`

```javascript
// Before
var request = require('request');
request.post({ url, json }, callback);

// After
const axios = require('axios');
await axios.post(url, json);
```

**Files Affected:**
- `lib/plugins/maker.js`
- `lib/plugins/pushover.js`
- `lib/plugins/bridge.js`
- `lib/server/bootevent.js`

**Effort:** Low | **Complexity:** Straightforward (find-and-replace pattern)

#### 3.1.2 Update Node.js Requirements

**Action:** Require Node.js 18 LTS minimum

```json
{
  "engines": {
    "node": ">=18.0.0",
    "npm": ">=8.0.0"
  }
}
```

**Effort:** Low | **Complexity:** Straightforward (config change only)

#### 3.1.3 Add Input Validation

**Action:** Implement Zod schemas for API endpoints

```javascript
const { z } = require('zod');

const entrySchema = z.object({
  type: z.enum(['sgv', 'mbg', 'cal']),
  sgv: z.number().int().min(20).max(600).optional(),
  date: z.number().int().positive(),
  direction: z.string().optional()
});

// Middleware
function validateBody(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      res.status(400).json({ error: err.issues });
    }
  };
}
```

**Effort:** Medium | **Complexity:** Moderate (many endpoints, testing needed)

#### 3.1.4 Add Rate Limiting

**Action:** Implement express-rate-limit

```javascript
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 100,  // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);
```

**Effort:** Low | **Complexity:** Straightforward (middleware addition)

#### 3.1.5 Add Structured Logging

**Action:** Replace console.log with pino

```javascript
const pino = require('pino');
const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

// Usage
logger.info({ event: 'data_update', entries: count }, 'Data updated');
logger.error({ err, endpoint }, 'Request failed');
```

**Effort:** Medium | **Complexity:** Straightforward (systematic replacement)

### Phase 2: Developer Experience

**Goal:** Improve developer productivity and code quality  
**Effort:** High | **Complexity:** Moderate to Complicated

#### 3.2.1 Add TypeScript Support

**Strategy:** Incremental adoption using JSDoc + TypeScript checking

**Step 1:** Add tsconfig.json with allowJs

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "target": "ES2020",
    "module": "CommonJS",
    "strict": false
  },
  "include": ["lib/**/*"]
}
```

**Step 2:** Add type definitions for core modules

```typescript
// types/context.d.ts
interface NightscoutContext {
  bus: EventEmitter;
  ddata: DataStore;
  plugins: PluginManager;
  notifications: NotificationManager;
  // ...
}
```

**Step 3:** Convert files incrementally (`.js` → `.ts`)

**Effort:** High | **Complexity:** Moderate (incremental, ongoing)

#### 3.2.2 Async/Await Refactoring

**Strategy:** Convert callback-based code to async/await

```javascript
// Before
function setupStorage(ctx, next) {
  require('../storage/mongo-storage')(env, function(err, store) {
    if (err) {
      ctx.bootErrors.push({ err });
    }
    ctx.store = store;
    next();
  });
}

// After
async function setupStorage(ctx) {
  try {
    ctx.store = await require('../storage/mongo-storage')(env);
  } catch (err) {
    ctx.bootErrors.push({ err });
  }
}
```

**Priority Files:**
1. `lib/server/bootevent.js`
2. `lib/authorization/index.js`
3. `lib/api3/` endpoints
4. `lib/data/dataloader.js`

**Effort:** Medium | **Complexity:** Moderate (requires understanding callback patterns)

#### 3.2.3 Testing Infrastructure

**Action:** Expand test coverage

```javascript
// Example: API endpoint tests
describe('GET /api/v3/entries', () => {
  it('should return entries for authorized user', async () => {
    const response = await request(app)
      .get('/api/v3/entries')
      .set('Authorization', `Bearer ${validToken}`)
      .expect(200);
    
    expect(response.body.status).toBe(200);
    expect(response.body.result).toBeInstanceOf(Array);
  });
  
  it('should reject unauthorized requests', async () => {
    await request(app)
      .get('/api/v3/entries')
      .expect(401);
  });
});
```

**Coverage Targets:**
- API endpoints: 80%
- Plugin logic: 70%
- Authorization: 90%
- Data processing: 75%

**Effort:** High | **Complexity:** Moderate (ongoing effort)

### Phase 3: Performance & User Experience

**Goal:** Improve client-side performance and user experience  
**Effort:** Medium | **Complexity:** Moderate

#### 3.3.1 Bundle Optimization

**Actions:**

1. **Replace Moment.js with dayjs:**
```javascript
// Before
const moment = require('moment-timezone');
moment(date).format('HH:mm');

// After
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs(date).format('HH:mm');
```

**Size Reduction:** ~200KB

2. **Tree-shake Lodash:**
```javascript
// Before
const _ = require('lodash');
_.debounce(fn, 1000);

// After
import debounce from 'lodash-es/debounce';
debounce(fn, 1000);
```

**Size Reduction:** ~50KB

3. **Code Splitting (Webpack Dynamic Imports):**
```javascript
// Lazy load reports module using Webpack dynamic imports
// This works with the existing jQuery/D3 architecture
function loadReportsModule() {
  return import(/* webpackChunkName: "reports" */ './reports').then(module => {
    return module.default;
  });
}

// Usage: Load reports only when needed
$('#reports-tab').on('click', async function() {
  const reports = await loadReportsModule();
  reports.init(client);
});
```

**Effort:** Low to Medium | **Complexity:** Straightforward (library swaps + config)

#### 3.3.2 PWA Support

**Actions:**

1. **Add Service Worker:**
```javascript
// service-worker.js
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('nightscout-v1').then((cache) => {
      return cache.addAll([
        '/',
        '/bundle/bundle.js',
        '/bundle/bundle.css'
      ]);
    })
  );
});
```

2. **Add Web Manifest:**
```json
{
  "name": "Nightscout",
  "short_name": "NS",
  "start_url": "/",
  "display": "standalone",
  "theme_color": "#000000"
}
```

**Effort:** Low | **Complexity:** Straightforward (add new files)

#### 3.3.3 Migrate jQuery to Vanilla JS

**Strategy:** Incremental replacement

```javascript
// Before
$('#currentBG').text(bg);
$('#container').addClass('urgent');
$('.pill').on('click', handler);

// After
document.getElementById('currentBG').textContent = bg;
document.getElementById('container').classList.add('urgent');
document.querySelectorAll('.pill').forEach(el => {
  el.addEventListener('click', handler);
});
```

**Effort:** High | **Complexity:** Complicated (incremental, many touch points)

### Phase 4: Architecture Improvements

**Goal:** Improve scalability and maintainability  
**Effort:** High | **Complexity:** Complicated

#### 3.4.1 Event-Driven Refactoring

**Action:** Replace Stream-based bus with typed EventEmitter

```typescript
// lib/bus.ts
import { EventEmitter } from 'events';

interface BusEvents {
  'tick': (tick: TickEvent) => void;
  'data-received': () => void;
  'data-loaded': () => void;
  'notification': (notify: Notification) => void;
  'teardown': () => void;
}

class TypedEventBus extends EventEmitter {
  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
  
  on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): this {
    return super.on(event, listener);
  }
}
```

**Effort:** Medium | **Complexity:** Moderate (contained refactor)

#### 3.4.2 Database Migration System

**Action:** Implement proper migrations using migrate-mongo

```javascript
// migrations/20260101-add-identifier-index.js
module.exports = {
  async up(db) {
    await db.collection('entries').createIndex({ identifier: 1 });
  },
  
  async down(db) {
    await db.collection('entries').dropIndex('identifier_1');
  }
};
```

**Effort:** Low | **Complexity:** Straightforward (new tooling, minimal code changes)

#### 3.4.3 OIDC/OAuth2 Plugin

**Action:** Add OpenID Connect and OAuth2 support as a plugin for vendor-agnostic identity

**Rationale:**
- Delegate identity complexity to purpose-built tools
- Keep Nightscout focused on CGM data handling
- Enable integration with enterprise identity providers
- Support consent and delegation workflows

**Architecture:**
```
┌─────────────────────────────────────────────────────────────────────────┐
│                        IDENTITY LAYER (External)                         │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐     │
│  │   Ory Hydra     │    │   Ory Kratos    │    │  Other IdPs     │     │
│  │ (OAuth2/OIDC)   │    │ (Identity Mgmt) │    │ (Okta, Auth0)   │     │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘     │
│           └──────────────────────┼──────────────────────┘              │
│                                  ▼                                      │
│                    ┌─────────────────────────────┐                      │
│                    │  nightscout-roles-gateway   │                      │
│                    │  (Consent & Delegation)     │                      │
│                    │  github.com/t1pal/...       │                      │
│                    └──────────────┬──────────────┘                      │
└───────────────────────────────────┼─────────────────────────────────────┘
                                    │ OIDC claims → NS permissions
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           NIGHTSCOUT                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  OIDC Plugin (lib/plugins/oidc.js)                              │   │
│  │  - Validate OIDC tokens                                          │   │
│  │  - Map claims to Shiro permissions                               │   │
│  │  - Coexist with existing API_SECRET auth                         │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

**Implementation Approach:**
```javascript
// lib/plugins/oidc.js
const { Issuer } = require('openid-client');

async function init(env, ctx) {
  const issuer = await Issuer.discover(env.OIDC_ISSUER_URL);
  const client = new issuer.Client({
    client_id: env.OIDC_CLIENT_ID,
    client_secret: env.OIDC_CLIENT_SECRET
  });

  // Middleware to validate OIDC tokens
  ctx.authorization.addTokenValidator('oidc', async (token) => {
    const userinfo = await client.userinfo(token);
    return mapClaimsToPermissions(userinfo);
  });
}
```

**Effort:** Medium | **Complexity:** Moderate (well-defined protocol, existing libraries)

#### 3.4.4 Multitenancy via External Gateway

**Action:** Support multiple data holders through nightscout-roles-gateway

**Reference:** https://github.com/t1pal/nightscout-roles-gateway

**Capabilities:**
- **Consent Management:** Data holder controls who can access their data
- **Delegation:** Caregivers, clinicians, AI agents with scoped permissions
- **Authority Hierarchy:** Aligns with Control Plane RFC (Human > Agent > Controller)
- **Audit Trail:** Who accessed what data, when, with what permissions

**Integration Points:**
```javascript
// Gateway handles:
// 1. User authentication via Ory Kratos
// 2. OAuth2 consent flows via Ory Hydra
// 3. Permission mapping to Nightscout Shiro permissions
// 4. Multi-tenant routing (optional)

// Nightscout receives:
// - Standard OIDC token with claims
// - Claims include: subject_id, permissions[], delegated_by, expires_at
```

**Benefits over Internal Implementation:**
- Separation of concerns (identity vs. CGM data)
- Proven identity infrastructure (Ory stack)
- Standards-compliant (OAuth2, OIDC)
- Easier security audits (smaller attack surface in Nightscout)

**Effort:** Medium | **Complexity:** Moderate (integration work, minimal Nightscout changes)

### Phase 5: UI Modernization

**Goal:** Modern, responsive, accessible user interface  
**Effort:** Very High | **Complexity:** Complicated

#### 3.5.1 Component Framework Adoption

**Recommendation:** Vue.js or Svelte for incremental migration

**Vue.js Strategy:**
1. Create Vue components for new features
2. Mount Vue components alongside existing DOM
3. Gradually replace jQuery-based UI

```javascript
// Mount Vue component in existing app
import { createApp } from 'vue';
import StatusPills from './components/StatusPills.vue';

createApp(StatusPills).mount('#status-pills');
```

**Effort:** Very High | **Complexity:** Complicated (major architecture shift)

#### 3.5.2 Accessibility Improvements

**Actions:**

1. Add ARIA labels
2. Implement keyboard navigation
3. Add screen reader announcements
4. Improve color contrast
5. Add focus indicators

```html
<!-- Before -->
<div class="pill" onclick="ack()">120</div>

<!-- After -->
<button 
  class="pill" 
  role="button"
  aria-label="Current blood glucose: 120 mg/dL. Press to acknowledge."
  tabindex="0"
  onclick="ack()"
  onkeypress="if(event.key==='Enter')ack()">
  120
</button>
```

**Effort:** Medium | **Complexity:** Moderate (systematic, well-defined)

#### 3.5.3 Chart Library Migration

**Option 1:** Upgrade D3.js to v7

**Option 2:** Consider Chart.js for simpler charts

**Option 3:** Custom WebGL-based chart for performance

**Effort:** Medium to High | **Complexity:** Moderate to Complicated (depends on option chosen)

---

## 4. Migration Strategies

### 4.1 Strangler Fig Pattern

For major subsystems, wrap old code and redirect gradually:

```javascript
// Phase 1: Wrapper
async function getEntries(query) {
  if (useNewImplementation()) {
    return newEntriesService.get(query);
  }
  return oldEntriesAPI.get(query);
}

// Phase 2: Migrate traffic
// Phase 3: Remove old code
```

### 4.2 Feature Flags

```javascript
const features = {
  USE_NEW_AUTH: process.env.FEATURE_NEW_AUTH === 'true',
  USE_REDIS_CACHE: process.env.FEATURE_REDIS_CACHE === 'true',
  USE_VUE_COMPONENTS: process.env.FEATURE_VUE === 'true'
};

if (features.USE_NEW_AUTH) {
  app.use('/api', newAuthMiddleware);
} else {
  app.use('/api', legacyAuthMiddleware);
}
```

### 4.3 Parallel Running

For critical subsystems (notifications), run old and new in parallel:

```javascript
async function sendNotification(notify) {
  // Run both, compare results
  const [oldResult, newResult] = await Promise.all([
    oldNotificationSystem.send(notify),
    newNotificationSystem.send(notify)
  ]);
  
  if (oldResult !== newResult) {
    logger.warn({ oldResult, newResult }, 'Notification mismatch');
  }
  
  return oldResult; // Use old until validated
}
```

---

## 5. Risk Mitigation

### 5.1 Health-Critical Considerations

| Change | Risk | Mitigation |
|--------|------|------------|
| Auth refactoring | Users locked out | Feature flag, gradual rollout |
| Notification changes | Missed alerts | Parallel running, extensive testing |
| Data layer changes | Data loss/corruption | Comprehensive backups, migrations |
| API changes | Breaking clients | Version compatibility, deprecation |

### 5.2 Testing Requirements

| Phase | Test Coverage | Type |
|-------|--------------|------|
| Phase 1: Security Foundation | 80%+ | Unit, integration |
| Phase 2: Developer Experience | 75%+ | Unit, E2E |
| Phase 3: Performance & UX | 70%+ | Performance, visual |
| Phase 4: Architecture | 80%+ | Load, chaos |
| Phase 5: UI Modernization | 70%+ | Accessibility, E2E |

### 5.3 Rollback Procedures

1. **Database:** Maintain migration rollback scripts
2. **API:** Version headers, backwards compatibility
3. **Client:** Serve multiple bundle versions
4. **Features:** Feature flags for instant rollback

---

## 6. Resource Estimates

### 6.1 Development Effort

| Phase | Effort | Complexity | Team Size |
|-------|--------|------------|-----------|
| Phase 1: Security Foundation | Low to Medium | Straightforward | 1-2 developers |
| Phase 2: Developer Experience | High | Moderate to Complicated | 2 developers |
| Phase 3: Performance & UX | Medium | Moderate | 1-2 developers |
| Phase 4: Architecture | High | Complicated | 2 developers |
| Phase 5: UI Modernization | Very High | Complicated | 2-3 developers |

### 6.2 Infrastructure

| Item | Requirement | Cost Estimate |
|------|-------------|---------------|
| Redis | Production Redis | ~$50-200/month |
| CI/CD | GitHub Actions | Free (open source) |
| Monitoring | Datadog/Grafana | ~$0-100/month |
| Load Testing | k6/Artillery | Free |

---

## 7. Success Metrics

### 7.1 Accuracy

| Metric | Current | Target |
|--------|---------|--------|
| Notification delivery rate | Unknown | >99.9% |
| Data consistency errors | Unknown | <0.01% |
| API error rate | Unknown | <0.1% |

### 7.2 Velocity

| Metric | Current | Target |
|--------|---------|--------|
| Time to deploy | Manual | <10 min |
| Test suite runtime | ~5 min | <3 min |
| New developer onboarding | ~1 week | ~2 days |

### 7.3 Maintainability

| Metric | Current | Target |
|--------|---------|--------|
| Code coverage | ~40% | >75% |
| TypeScript coverage | 0% | >60% |
| Documentation | Partial | Comprehensive |
| Dependency age | Mixed | <1 year |

---

## 8. Related Documents

- [Architecture Overview](./architecture-overview.md)
- [Security Audit](../audits/security-audit.md)
- [API Layer Audit](../audits/api-layer-audit.md)
- [Data Layer Audit](../audits/data-layer-audit.md)
- [Real-Time Systems Audit](../audits/realtime-systems-audit.md)
- [Plugin Architecture Audit](../audits/plugin-architecture-audit.md)
- [Dashboard UI Audit](../audits/dashboard-ui-audit.md)
- [Messaging Subsystem Audit](../audits/messaging-subsystem-audit.md)
