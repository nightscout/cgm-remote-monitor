# The deployment plan contract

*Contributor-facing: for people who write or maintain a deployment plan for the
multitenant roles (nightscout-deploy's Compose binding, a Kubernetes rendering,
a hosting provider's own tooling). Everything here is synthetic or structural;
no credential appears in a role document.*

A **deployment plan** is the program that decides, for one installation, which
role processes run, what each one's environment is and what its configuration
files say. Core does not ship a plan. Core publishes the **contract** a plan must
meet, and a command that checks a plan's output against it:

```bash
nightscout plan check documents.json     # exit 0 accepted, 1 findings, 64 unreadable input
nightscout plan contract                 # the contract as one JSON value
```

A plan pins a core commit and runs `plan check` from that commit on what it
generates. The answer is the one the role processes would give at start-up,
because the check runs their own configuration code.

## The document set

`plan check` takes one JSON value: every role process the plan would start, with
the roles it serves, its environment, and the JSON files its environment names.

```json
{ "contract": 1,
  "processes": [
    { "name": "api",
      "roles": ["api"],
      "environment": { "MULTITENANT_PREVIEW_CONFIG": "/run/ns-config/config.json",
                       "MULTITENANT_OPERATION_CONFIG": "/run/ns-config/operation.json",
                       "NS_API_PG": "postgres://role:placeholder@postgres/db", "...": "..." },
      "files": { "/run/ns-config/config.json": { "version": 1, "...": "..." },
                 "/run/ns-config/operation.json": { "version": 2, "...": "..." } } } ] }
```

- `name` is the plan's own name for the process (a service or workload name).
  A replica or worker is its own entry.
- `roles` is the list given to `nightscout multitenant <role>[,<role>...]`.
- `environment` is the process environment as strings. A value that equals a key
  of `files` is that file's path.
- `files` holds each JSON file by the absolute path the process will read it at.

Connection addresses are parsed and never dialled, so a plan is checked with
placeholder credentials. The report does not repeat environment values. The
schema is [`document-set.schema.json`](../lib/server/serve/plan-contract/schema/document-set.schema.json).

## Role documents

Registry mode only: the tenant set, hosts and keys come from the
[tenant registry](tenant-registry.md), so no document lists tenants, per-tenant
keys or lock keys, and `MULTITENANT_STATIC_TENANTS` is not set.

| document | environment variable naming its file | read by | schema | loader |
|---|---|---|---|---|
| api | `MULTITENANT_PREVIEW_CONFIG` | api | [`api.schema.json`](../lib/server/serve/plan-contract/schema/api.schema.json) | `lib/server/serve/preview-config.js` |
| realtime | `MULTITENANT_REALTIME_CONFIG` | realtime | [`realtime.schema.json`](../lib/server/serve/plan-contract/schema/realtime.schema.json) | `lib/server/realtime/config.js` |
| evaluator | `MULTITENANT_EVALUATOR_CONFIG` | evaluator; api as metadata, when `socketForwarding.consumerState` names it | [`evaluator.schema.json`](../lib/server/serve/plan-contract/schema/evaluator.schema.json) | `lib/server/serve/evaluator-config.js` |
| tenant-admin | `MULTITENANT_OWNER_PREVIEW_CONFIG` | tenant-admin | [`tenant-admin.schema.json`](../lib/server/serve/plan-contract/schema/tenant-admin.schema.json) | `lib/server/serve/owner-preview-config.js` |
| admin | `MULTITENANT_ADMIN_CONFIG` | admin | [`admin.schema.json`](../lib/server/serve/plan-contract/schema/admin.schema.json) | `lib/server/serve/admin-config.js` |
| feed-reader | `MULTITENANT_FEED_CONFIG` | feed-reader | [`feed-reader.schema.json`](../lib/server/serve/plan-contract/schema/feed-reader.schema.json) | `lib/change-feed/config.js` |
| operation | `MULTITENANT_OPERATION_CONFIG` | api, realtime, evaluator, tenant-admin | [`operation.schema.json`](../lib/server/serve/plan-contract/schema/operation.schema.json) | `lib/server/serve/operation-cohort-config.js` |

The schemas are JSON Schema (draft 2020-12) and use only `type`, `enum`, `const`,
`properties`, `required`, `additionalProperties`, `dependentRequired`,
`minProperties`, `maxProperties`, `items`,
`minItems`, `maxItems`, `uniqueItems`, `pattern`, `minLength`, `maxLength`,
`minimum` and `maximum`, so any validator in any language evaluates them.

Contract 1 does not describe the `vcpool` role's document
(`lib/tenant-connector/config.js`); `plan check` reports a process that serves it
as `PLAN_ROLE_NOT_COVERED`.

## What the check does

For each process, in order:

1. **Shape.** Each role document against its schema. A finding names the
   document and the field (`PLAN_DOCUMENT_SHAPE`, with a JSON Pointer).
2. **Load.** The files are written to a private temporary directory and the
   command's own configuration phase runs on them (`configure` in
   `lib/cli/commands/multitenant.js`): serve.internal settings, the operation
   cohort configuration, every selected role's loader and the static tenant list
   gate. A refusal is `PLAN_CONFIGURATION_REFUSED` with the loader's message. The
   loaders are the authority: rules a schema cannot state are theirs (separate
   database identities on one database, namespaces distinct from each other,
   bounds that depend on each other, exactly one Vault credential source).
3. **Set.** The rules `start` applies to the loaded configurations before it
   opens anything (`preflight` in `lib/server/serve/index.js`): listener
   settings, the roles one process may combine, and the participant manifest
   against the namespaces the loaded roles protect. A refusal is
   `PLAN_PROCESS_REFUSED`.

Other findings: `PLAN_DOCUMENT_SET_SHAPE` (the set itself), `PLAN_ROLES_REFUSED`
(an unknown or repeated role), `PLAN_DOCUMENT_MISSING` (the environment names a
file the entry does not carry), `PLAN_STATIC_TENANTS` (the lab flag is set).

The report is JSON on stdout: `ok`, and for each process its `findings`, the
`documents` that were checked against a schema, and `unchecked`, the files no
schema covers (a realtime placement map, for example; its own reader checks it
during the load step).

What the check does not do: it opens no database, Vault or peer connection, so
it says nothing about grants, migrations, row-level security, key material or
reachability. It checks each process on its own; that every participant a
manifest names is a process of the same set is established by the roles'
census at run time. A role's readiness checks cover the database side when the
process starts.

## The provisioning interface

A registry-mode plan creates tenants through the admin role, never by writing
role documents.

- **REST**, on the admin listener: `POST /v1/tenants`, `POST /v1/tenants/batch`,
  `GET` and `DELETE /v1/tenants/{id}`. The description is
  [`lib/tenant-registry/openapi.json`](../lib/tenant-registry/openapi.json), served
  as `GET /v1/openapi.json`; behaviour is in
  [the tenant registry](tenant-registry.md#provisioning) and the
  [operator REST API](internal-service-api.md#operator-rest-api-admin-listener).
- **CLI**: `nightscout admin provision (--id <uuid> --host <host>... | --seed <file>)`
  and `nightscout admin remove --id <uuid>`, clients of that API that hold no
  database or Vault credential (`lib/cli/commands/admin.js`).

`nightscout plan contract` prints the OpenAPI description with the schemas.

## How the contract stays in step with the loaders

`tests/multitenant-plan-contract.test.js` (unit tier) generates every document
from core's test plan (`tests/fixtures/multitenant-plan.js`) in three variants:
the smallest registry-mode plan, one that sets every optional field with a fixed
roster (two api instances, a named realtime worker), and that one again with
Vault token files in place of environment references. For each object of each
document it requires:

| name | rule | a loader change that turns it red |
|---|---|---|
| required | a field the schema requires is one the loader refuses to do without | a required field becomes optional |
| closed | a field the schema does not name is one the loader refuses | a loader stops refusing unknown fields |
| known | every field a loader reads or asks about is named by the schema, or is a static-mode field it refuses beside `registry` | a loader accepts and reads a new field |
| live | every field the schema names is one a loader reads | a loader drops or renames a field |
| carried | every field the schema names appears in a variant, so its type has met its loader | a field added to a schema without a document that carries it |

and that each variant as a whole is accepted, which a renamed, retyped or newly
required field breaks. The fields a loader reads are recorded by a Proxy around each
parsed document (`tests/fixtures/multitenant-plan-observer.js`). One change is
not seen: a field added to a loader's list of accepted names that the loader
never reads while loading.

A loader change that turns the suite red is finished when the schema and this
page say the same thing. The contract number moves when the document-set format
changes; role document fields follow the core commit a plan pins.
