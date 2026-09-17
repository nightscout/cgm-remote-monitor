# Nightscout Documentation Index

This index provides navigation for the Nightscout documentation structure. Each folder has a specific purpose to help developers and AI agents quickly find relevant information.

## Documentation Taxonomy

| Folder | Purpose | When to Use |
|--------|---------|-------------|
| `audits/` | System analysis and current state documentation | Understanding existing architecture, identifying issues |
| `meta/` | Project-level navigation and progress tracking | High-level orientation, roadmaps, overall progress |
| `requirements/` | Formal requirements specifications by area | Defining what must be true for correctness |
| `test-specs/` | Test specifications with progress tracking | Writing tests, tracking coverage gaps |
| `proposals/` | RFC-style proposals for new features | Proposing changes, reviewing designs |
| `data-schemas/` | Collection and field documentation | Understanding data structures |
| `plugins/` | Plugin-specific documentation | Working with specific plugins |

---

## Quick Navigation

### Meta (Start Here)
- [Architecture Overview](./meta/architecture-overview.md) - System design and component relationships
- [Modernization Roadmap](./meta/modernization-roadmap.md) - Future direction and priorities
- [Documentation Progress](./meta/DOCUMENTATION-PROGRESS.md) - What's been documented, what's pending

### System Audits
- [API Layer Audit](./audits/api-layer-audit.md) - REST endpoints (v1, v2, v3)
- [Data Layer Audit](./audits/data-layer-audit.md) - MongoDB collections and storage
- [Security Audit](./audits/security-audit.md) - Authentication, authorization, vulnerabilities
- [Real-Time Systems Audit](./audits/realtime-systems-audit.md) - Socket.IO, WebSocket handling
- [Messaging Subsystem Audit](./audits/messaging-subsystem-audit.md) - Notifications, alerts
- [Plugin Architecture Audit](./audits/plugin-architecture-audit.md) - Plugin system design
- [Dashboard UI Audit](./audits/dashboard-ui-audit.md) - Frontend components

### Requirements
- [Data Shape Requirements](./requirements/data-shape-requirements.md) - Input/output shape handling
- [Authorization Security Requirements](./requirements/authorization-security-requirements.md) - Auth system requirements
- [API v1 Compatibility Requirements](./requirements/api-v1-compatibility-requirements.md) - Client compatibility

### Test Specifications
- [Shape Handling Tests](./test-specs/shape-handling-tests.md) - Array/object normalization tests
- [Authorization Tests](./test-specs/authorization-tests.md) - Security and auth tests
- [Coverage Gaps](./test-specs/coverage-gaps.md) - Aggregated test gaps by priority

### Data Schemas
- [Treatments Schema](./data-schemas/treatments-schema.md) - Treatment collection fields
- [Profiles Schema](./data-schemas/profiles-schema.md) - Profile structure

### Proposals
- [OIDC Actor Identity](./proposals/oidc-actor-identity-proposal.md) - Verified actor identity RFC
- [Agent Control Plane](./proposals/agent-control-plane-rfc.md) - AI agent collaboration design
- [Testing Modernization](./proposals/testing-modernization-proposal.md) - Test framework updates
- [MongoDB Modernization](./proposals/mongodb-modernization-implementation-plan.md) - Driver upgrade plan

---

## For AI Agents

When working in this codebase:

1. **Start with INDEX.md** (this file) to orient yourself
2. **Check test-specs/** for the area you're working on - each spec tracks its own progress and gaps
3. **Check requirements/** for formal correctness criteria
4. **Check audits/** for current implementation details
5. **Update the relevant test-spec's Progress section** when you make discoveries

### Quine-Style Iteration Pattern

Each test area is self-contained with:
- Requirements (what must be true)
- Test specifications (how to verify)
- Progress tracking (what's done, what's discovered)
- Priority gaps (what to work on next)

This allows focused iteration on one topical area at a time.
