# Private operator management-session issuance

`admin.managementSessions` composes
`POST /v1/tenants/{id}/management-sessions` on the private admin listener. The
existing D7 deployment boundary secures that listener. The issuer requires an
existing, active updating owner and named subject; it does not grant ownership.
Every subsequent use still performs the existing current management-authority
verification.

Configuration uses `connectionEnv`, distinct `namespaces` for `authorization`,
`registry`, `access`, and `control`, explicit `issuer`, `audience`, owner
`consumer`, and `operator: {principal, consumer}`. `maxLifetimeSeconds` defaults
to 600 and cannot exceed 600. `vault` uses the existing address/mount and
exclusive tokenFile/tokenEnv capability configuration. Its token needs only
metadata read and sign on the fixed `tenant-management-<uuid>` key family.

The request is `{subjectId, requestId, lifetimeSeconds?}`. `requestId` is a UUID
persisted by the caller before its first attempt; optional `Idempotency-Key`
must match it. Success returns `{token, expiresAt, sessionId, requestId, outcome}`
with integer epoch seconds and outcome `created` (201) or `existing` (200).
A current retry returns the same signed claims. Expired or revoked sessions
require a new explicit request. The token is returned only in this no-store
response; neither the audit ledger nor logs contain its plaintext.

Install the appended access catalogue migration first. Create distinct issuer
LOGIN and authority-owner NOLOGIN roles, then apply `grants({namespaces, issuer,
authorityOwner}).authorityOwner` followed by `.issuer`. The helper does not
create roles or migrate schemas. The NOLOGIN role has only current authority
SELECT and the particular column UPDATE grants PostgreSQL requires for row
SHARE locking. The login cannot update ownership, registry, key, activity or
phase metadata: it has EXECUTE on the pinned wrapper, current phase reads, and
exact credential/session/request privileges. FORCE RLS and the existing
transaction tenant binding remain mandatory. Exact authority function body,
search path, role flags, grants and catalogue are checked at startup and before
each issuance.

The transaction holds the existing shared tenant operation-window advisory
lease through signing and durable audit commit. Authority rows and the activity
row are SHARE locked, serializing existing revoke/rotation/deletion writers.
Restore may suspend the tenant while waiting for the lease; the final phase
read then refuses issuance and releases it. No restore authority is granted.
The immutable request ledger belongs to the access authority family: logical
restore preserves its current rows with credentials and sessions; it is not an
operational exclusion. The issuer's live metadata-only backend passes current
restore census, while an added clinical clock UPDATE grant correctly refuses.

The fixed Vault key metadata maps explicit Ed25519 versions to currently enabled
registry/access management key IDs. New issuance chooses the highest matching
version; retry pins its original still-enabled version. No mapping, ambiguous
mapping, a retired signing minimum, provider failure, or signature mismatch
refuses issuance. Legacy signing-version metadata is not used.
