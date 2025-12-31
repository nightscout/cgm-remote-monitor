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

## Recent Changes
- 2025-12-31: Updated to version 15.0.4 (dev branch)
- Configured for Replit with INSECURE_USE_HTTP=true
- MongoDB 3.6.x driver
- Webpack bundling for frontend
