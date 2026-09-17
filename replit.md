# Nightscout CGM Remote Monitor

## Overview
Nightscout is a web-based Continuous Glucose Monitor (CGM) system enabling remote, real-time viewing of patient glucose data. Its core purpose is to provide robust glucose monitoring, data visualization, and alert capabilities for patient care and clinical research. The project supports multiple API versions and features a plugin-based architecture for extensibility. Future ambitions include enhanced AI agent collaboration via a dedicated control plane, modernized testing, and advanced authentication mechanisms.

## User Preferences
I want iterative development. Ask before making major architectural changes. Provide detailed explanations for complex technical decisions.

## System Architecture
The Nightscout system is a modular Node.js application backed by MongoDB. It separates server core, API versions (v1, v2, v3), authorization, plugins, and client-side components.

### UI/UX Decisions
The frontend uses Webpack for asset bundling and D3/jQuery for dynamic charting, delivering a comprehensive dashboard experience.

### Technical Implementations
- **API Versions:**
    - **API v1 (`/api/v1`):** Core CGM data, treatments, profiles, device status with `API_SECRET` authentication.
    - **API v2 (`/api/v2`):** Extends v1 with JWT-based authorization, roles, and permissions.
    - **API v3 (`/api/v3`):** Modern OpenAPI 3.0 REST API for comprehensive CRUD operations; Swagger UI available at `/api3-docs`.
- **Authentication:**
    - **API v1:** SHA1 hash of `API_SECRET`.
    - **API v2/v3:** JWT `Bearer` tokens with fine-grained permissions.
- **Real-time Data:** Socket.IO for live data updates and alarms.
- **Plugin Architecture:** Extensible system supporting various plugins (e.g., ar2, basal, bolus).
- **Agentic Control Plane (Proposed):** A clean separation of control plane (policy, configuration) and data plane (telemetry, delivery) to facilitate AI agent collaboration using event-driven architecture and JSON schemas for event envelopes.
- **Testing & Modernization (Proposed):** Strategy to update testing libraries, separate logic from DOM for isolated testing, and evaluate new UI technologies.
- **Security:** IP-based brute-force protection for authentication.
- **MongoDB Compatibility:** Updates for MongoDB Driver 5.x, addressing multi-document writes, race conditions, and optimized connection pooling (default `MONGO_POOL_SIZE=5`).
- **Prediction Array Truncation:** Automatic truncation of prediction arrays to 288 elements by default to prevent oversized MongoDB documents, configurable via `PREDICTIONS_MAX_SIZE`.
- **OIDC Actor Identity (Proposed):** OpenID Connect integration for cryptographically-verified actor identities, replacing `enteredBy` for enhanced audit trails and delegation tracking.

### System Design Choices
- **Event-driven architecture** for control plane.
- **Append-only event streams**.
- **Monorepo structure**.
- **Environment variables** for flexible configuration (`PORT`, `MONGO_CONNECTION`, `API_SECRET`).

## External Dependencies
- **MongoDB:** Primary database.
- **Socket.IO:** Real-time communication.
- **Webpack:** Frontend asset bundling.
- **Nodemon:** Development server.
- **Mocha, Supertest, NYC:** Testing frameworks.
- **Pushover, IFTTT Maker:** Messaging and notifications.
- **Alexa, Google Home:** Voice assistant integrations.