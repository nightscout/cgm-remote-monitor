# Operator-assisted tenant ownership

Contributor-facing. The first multitenant preview changes tenant ownership through
the private operator plane only: list owners, add a co-owner, transfer ownership
and recover ownership. Owners cannot add co-owners or transfer ownership
themselves in this preview (16.0.0 release decision
`preview-operator-assisted-ownership`).

An owner is an explicit relationship: an active `tenant_owner_actors` row with
`can_update`, whose `principal` is an existing subject of the tenant. The owner
plane (`lib/subject-admin/owner-policy.js`, `lib/human-session/postgres.js`)
reads those rows as current authority on each protected operation, so a change
applies to the next owner request on every worker.

## Operations

`createOwnershipOperations({ store, authorizeOperator })` takes the operator
identity `{ principal, consumer }` from trusted composition and the target tenant
from the request.

| operation | input | effect |
|---|---|---|
| `list` | `{ tenant }` | current owners; no write, no audit |
| `add` | `{ tenant, owner, delegable, expectedOwners }` | `owner` becomes an additional owner with `delegable` |
| `transfer` | `{ tenant, from, to, expectedOwners }` | `from` stops being an owner; `to` becomes one with `from`'s delegation |
| `recover` | `{ tenant, owner, delegable, expectedOwners }` | `owner` becomes the only active owner; every other active actor row is retired |

`owner`, `from` and `to` are `{ principal, consumer }`, the principal a subject
id. `delegable` is a list of Shiro permission strings that must fit the tenant's
current operator ceiling. `expectedOwners` is the owner set the operator
observed (from `list`): the change applies only while it is still the current set,
so a concurrent change is never silently replaced. `recover` accepts
`expectedOwners: []` for a tenant with no usable owner.

Every outcome is one of:

- `applied`: the change committed with one audit row; `owners` is the new set.
- `refused` (`OWNERSHIP_CONFLICT`, `_NOT_OWNER`, `_ALREADY_OWNER`,
  `_SUBJECT_UNKNOWN`, `_DELEGATION_EXCEEDS_CEILING`, `_UNCHANGED`): no ownership
  change; the attempt is audited; `owners` is the current set.
- `OWNERSHIP_FORBIDDEN`, `OWNERSHIP_TENANT_UNKNOWN`, `OWNERSHIP_INVALID` (the
  service reports these as `denied`): no row, lock-holding write or audit in any
  tenant, and no owner list returned.

No operation reads, issues, returns or logs a credential, key or secret.
Recovery restores an owner relationship only. The recovered owner signs in
through their own identity mapping or an operator-provisioned management
credential, through the existing paths.

## Current operator authority

`authorizeOperator({ connection, operation, tenant, principal, consumer })` is
called inside the store transaction before any read of ownership rows. It must
return exactly `{ allowed: true, current: true, tenant, plane: 'operator',
principal, consumer }` for the requested tenant and actor; any other answer,
including one naming a different tenant, refuses `OWNERSHIP_FORBIDDEN`. This is
the shape the deletion ceremony's `authorize` uses. `service.tenantSetAuthority({
principal, consumer, tenants })` is the shipped adapter: the composed operator
acts only for the listed tenants.

## Transactions and races

PostgreSQL store `createPostgresOwnership({ connectionString, namespace })`, in the
authorization namespace. One transaction per operation, `synchronous_commit=on`:

1. current operator authority;
2. `tenant_authorization_config` `FOR SHARE`, then `tenant_owner_policy`
   `FOR UPDATE`, then every `tenant_owner_actors` row of the tenant `FOR UPDATE`
   (the subject-admin lock order). Owner-plane mutations hold the policy row
   `FOR SHARE`, so they and every ownership change for the tenant serialize;
3. plan against the locked state (`plan()` in `component.js`);
4. conditional writes (`... AND active=true`; insert-or-reactivate only an
   inactive row) under a savepoint. A write that matches no row, or a result
   without the named target or without any owner, rolls back to the savepoint
   and is audited as `OWNERSHIP_CONFLICT`.

The row locks and the conditional writes are independent: either one alone keeps
two concurrent transfers from both applying (the integration suite's race
control). Removing both lets both apply.

## Audit

Append-only authorization migration `0006_owner_ownership_operations` adds the
verbs `owner-add`, `owner-transfer`, `owner-recover` and the nullable `outcome`
(`applied`/`refused`) and `detail` (JSON object, at most 8 KiB) columns to
`tenant_subject_admin_audit`. A constraint requires both for the owner verbs and
neither for the existing verbs. `principal`/`consumer` name the operator,
`subject_id` the target, and `detail` holds identifiers only: the named actors,
the expected and observed owner sets, the resulting set or refusal code.

## Database identity

The operator ownership identity is separate from owner, data and secrets
identities. Startup refuses any other privilege shape (`OWNERSHIP_STORE_UNSAFE`):

| table | privileges |
|---|---|
| `tenant_authorization_config`, `tenant_owner_policy` | SELECT, UPDATE(`owner_fence`) for row locks |
| `tenant_owner_actors` | SELECT, INSERT, UPDATE(`active`, `can_update`, `delegable`) |
| `tenant_authorization_subjects` | SELECT |
| `tenant_subject_admin_audit` | INSERT |

No DELETE, TRUNCATE, table-level UPDATE, ownership of a table, BYPASSRLS or
access to credential, secret or session tables. Forced tenant RLS applies.

## Private service

`service.open(endpoint, { ownership, operator })` opens the `ownership-operations`
internal service (`lib/server/internal-api/contracts/ownership-operations.json`)
on its own Unix socket or explicitly configured internal HTTP endpoint, never on a
public router; clients use `clients.ownershipOperations(endpoint)`. The transport's
trust model is described in [internal service APIs](../../docs/internal-service-api.md).
The `admin` serving role in `lib/server/serve/roles.js` has no runtime yet; composing
this service into it is the next integration step.
