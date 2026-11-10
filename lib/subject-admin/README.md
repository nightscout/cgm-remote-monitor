# Tenant owner subject and role administration

The owner listener composes current management authentication, tenant resolution,
subject administration and the PostgreSQL writer. Data permissions, including `*`,
and tenant root credentials confer no management membership. Single-tenant MongoDB
administration keeps its existing routes and storage behavior. Both stores share
[`default-roles.js`](../authorization/default-roles.js) for shipping role definitions.

## Capability

`createSubjectAdmin({store,authorizeManagement,issueCredential?})` accepts only an
explicit authenticated `{tenant,principal,consumer}`. The service independently
authorizes every operation. The selected PostgreSQL store reads and SHARE-locks
current configuration, catalogue/operator ceiling, active owner actor and explicit
delegation inside the mutation transaction. Possessing data permission does not
supply delegation. Assignments lock current role definitions before target subject
and legacy metadata rows; deletion and issuance use the same authority-first order.

- `create(context,{name,roles?,notes?,created_at?})` allocates a fresh stable ID and
  atomically writes subject, legacy token prefix, known role links and redacted audit.
- `update(context,id,input)` preserves the stable ID, omitted notes and stored
  creation time. Omitted roles revoke all assigned roles; unknown roles refuse.
- `createRole(context,{name,permissions})` defines a tenant-local role. Existing
  names conflict instead of replacing another role's authority.
- `remove(context,id)` revokes by deleting role links, credential metadata and
  subject together. It needs current owner authority even with an empty ceiling;
  revoking a grant does not require permission to delegate that grant.
- `credential(context,id)` calls the optional secrets issuer inside a current
  authority/role/subject/metadata fence, then returns only after commit. Without a
  configured issuer this operation refuses `SUBJECT_ADMIN_UNSUPPORTED`.

All mutations use `synchronous_commit=on`. Missing metadata, unknown roles,
revoked actors, exceeded ceilings, audit errors and datastore uncertainty refuse
without partial writes. Two workers consult the same current rows. An operation
already holding authority locks may complete before a waiting revoker; there is
no promised propagation interval or protection against stolen raw writer access.

## Wildcards and ceilings

[`permission-implication.js`](permission-implication.js) compiles through the actual
shipped `shiro-trie` and checks language containment, including wildcard, comma,
prefix and extension behavior. It explores trie-state pairs over literals plus an
unknown-segment representative. It does not enumerate a finite set of terminal API
operations, and calling `check('*')` is not used as containment evidence.

A proposed grant must fit project catalogue, current operator ceiling and current
actor delegation independently. `catalogue:['*']` permits the complete shipped
permission language; an older explicitly narrow catalogue/digest stays narrow
until the operator changes it. Empty ceilings deny new nonempty grants. Default
`admin=['*']` and `readable=['*:*:read']` retain their shipping meaning. Anonymous
`denied/readable/status-only` remain independently read-clamped by the data reader.
Status-only retains the existing explicit status requirement during assignment.

The installed Shiro package has inherited-object edge behavior for names such as
`hasOwnProperty` and `__proto__`; this change does not repair or invent a new grammar
for that dependency. Ordinary data checks retain the same package behavior.

## HTTP and secrets composition

The JSON management factory opens no listener itself. Its routes are:

| route | operation |
|---|---|
| `POST /api/v2/authorization/subjects` | create subject |
| `PUT /api/v2/authorization/subjects` | update subject using `_id` |
| `DELETE /api/v2/authorization/subjects/:_id` | revoke subject |
| `POST /api/v2/authorization/roles` | define role |
| `POST /api/v2/authorization/subjects/:_id/credential` | issue credential; JSON `{}` |

Bodies are bounded to 64 KiB, unknown/derived credential fields refuse and responses
use `no-store` and `no-referrer`. Grant changes and credential issuance explicitly
request sensitive authentication; ordinary revocation does not request fresh
reauthentication. Authentication freshness is enforced by the management adapter,
not inferred from data roles. Successful operations await optional management
activity before responding; failed service operations do not extend idle time.
The human cookie/extraction hooks join through the OIDC lane's original history.
No owner-configurable integration kind is supported in the first preview.

The owner preview accepts optional `ownerCredentials` configuration parsed by
[`owner-credential-config.js`](../server/serve/owner-credential-config.js). It has
`connectionEnv`, a separate secrets `namespace`, a Vault configuration
`{address,mount,allowInsecureLoopback}`, and one entry per configured tenant with
`{id,tokenEnv,encryptionKey,signingKey,signingVersion}`. Database credentials and
Vault tokens are environment references. The secrets identity must differ from
owner writer/access identities and use the same database. Tenant keys and token
references are distinct. HTTPS is required except explicit loopback development.

The runtime factory exports only `issueCredential` and `close`. The secrets
component authorizes/audits `issue-legacy` separately from decrypt/reveal/sign,
derives the existing canonical raw subject token behind its boundary and clears
the decoded root buffer. It exports neither root plaintext nor signing keys and
stores no derived token. A supplied boot issuer and configured issuer together
refuse; absence of both leaves issuance unavailable.

## Explicit operator preparation

Apply/check the append-only authority `0005_owner_subject_creation`, secrets
`0003_secrets_legacy_issuance` and selected settings migrations with the private
migration runner. Existing migration bytes/checksums are unchanged. Application
startup never provisions schemas, default roles or credentials.

`provision-default-roles(connection,{namespace,tenant})` prepares all shipping
roles inside the operator's tenant transaction. Existing identical rows are
idempotent; changed definitions refuse for review instead of being overwritten.
A selected owner writer requires SELECT/INSERT/UPDATE/DELETE on subjects and
legacy metadata, SELECT/INSERT on roles, SELECT/INSERT/DELETE on role links,
INSERT on redacted audit, and SELECT plus only UPDATE(owner_fence) on current
config/policy/actor/role fence rows. It cannot edit role permissions or operator
policy. Startup screens forced RLS, nonownership and exact privilege shape.
A writer without an owner policy is not buildable: the PostgreSQL store is
multitenant-only and refuses construction without `ownerPolicy`. Secrets storage
uses its separately screened persistence identity.

A root-plane writer (`plane: 'root'`) has the same shape except that it holds
only SELECT on owner actor rows (no `UPDATE(owner_fence)`): the last-owner guard
reads them and root never locks them. Each plane refuses the other's identity.

## Tenant root (API_SECRET) on the DATA listener

Decisions `tenant-root-single-site-parity` and `root-may-edit-owner-subjects`
(16.0.0 release records). With the optional preview `subjectAdmin`
`{writerConnectionEnv,ownerPolicy:{catalogue}}` the DATA listener serves the
single-site admin tools routes to the resolved tenant's root secret only, with
the same paths, verbs and form or JSON payloads
([`root-admin.js`](../server/tenant-app/root-admin.js)):

| route | operation |
|---|---|
| `GET /api/v2/authorization/subjects` | list `{_id,name,roles,notes,accessToken}` |
| `POST /api/v2/authorization/subjects` | create subject |
| `PUT /api/v2/authorization/subjects` | update subject using `_id` (any subject, including an owner's) |
| `DELETE /api/v2/authorization/subjects/:_id` | remove subject; the last usable owner refuses `SUBJECT_ADMIN_LAST_OWNER` (409) |
| `GET /api/v2/authorization/roles` | list roles `{_id:name,name,permissions}` |
| `POST /api/v2/authorization/roles` | define role (`notes` accepted, not stored) |
| `PUT /api/v2/authorization/roles`, `DELETE /api/v2/authorization/roles/:_id` | `SUBJECT_ADMIN_UNSUPPORTED` (501) |

Root's grants stay inside the project catalogue and the current operator ceiling;
it has no owner actor row, so it has no settings, export, deletion, ownership or
issuance authority, and its audit rows read `root/<data consumer>`. The listed
`accessToken` is derived by the secrets component only when the presented secret
is that tenant's current root. Another tenant's root, a subject token, a bearer
token or no credential receive the shipping 401 envelope.

## Evidence boundary

Focused tests exercise actual components, Express dispatch/parsing without a
bound socket, current policy checks and PostgreSQL adapter transactions over an
explicit synthetic connection with independent stored-row oracles. Meaningful
controls bypass management authority, role ceilings, freshness classification,
permission containment, issuance authority and root clearing; assertions must
fail and restored source must pass. These are source proofs, not native database,
Vault, network HTTP, cookie or browser acceptance. Native migration execution,
R53 current-ceiling/actor lock races, cross-worker revocation and coherent runtime
compatibility remain the next integration lead's acceptance boundary.
