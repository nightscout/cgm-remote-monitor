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
| vcpool | `MULTITENANT_VCPOOL_CONFIG` | vcpool | [`vcpool.schema.json`](../lib/server/serve/plan-contract/schema/vcpool.schema.json) | `lib/tenant-connector/config.js` |
| feed-reader | `MULTITENANT_FEED_CONFIG` | feed-reader | [`feed-reader.schema.json`](../lib/server/serve/plan-contract/schema/feed-reader.schema.json) | `lib/change-feed/config.js` |
| operation | `MULTITENANT_OPERATION_CONFIG` | api, realtime, evaluator, tenant-admin | [`operation.schema.json`](../lib/server/serve/plan-contract/schema/operation.schema.json) | `lib/server/serve/operation-cohort-config.js` |

The schemas are JSON Schema (draft 2020-12) and use only `type`, `enum`, `const`,
`properties`, `required`, `additionalProperties`, `dependentRequired`,
`minProperties`, `maxProperties`, `items`,
`minItems`, `maxItems`, `uniqueItems`, `pattern`, `minLength`, `maxLength`,
`minimum` and `maximum`, so any validator in any language evaluates them.

Contract 1 describes all seven core role documents. Placement versions 1 and 2
are validated by the published actual parser with the process's resolved listener
context; they are not a second independently maintained shape schema.

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
`documents` that were checked against a schema or actual placement validator,
and `unchecked`. Carried unknown documents refuse rather than silently passing;
the report redacts their paths. Optional provisioning examples have their own
fixed result rows.

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


## Repaired publication boundary (source candidate)

The same `nightscout plan contract` and `nightscout plan check` interface now
covers all seven core role loaders, including registry vcpool. Shape schemas
are descriptive and checked against what loaders read/require/refuse. The
actual `multitenant.configure` and `serve.preflight` remain semantic authority;
placement inputs additionally call the actual placement parser with resolved
internal listeners and the selected ownership contract. Versions 1 and 2 are
separate supported placement selections. An unknown carried document or selected
configuration refuses. A selected physical-admission ticket/plan is explicitly
uncovered and refuses until its own authoritative validator is integrated;
operation document v2 is not that physical protocol.

This check uses private temporary JSON files and bounded retained placement
readers. It is not zero-file-I/O or resource-free. Positive map1/map2 graphs and
configuration/preflight failures have descriptor-custody controls. Omitting the
checker close breaks the descriptor oracle; close errors refuse and every owned
reader close is attempted. Source tests deny network/listeners, PG connections,
HTTP/provider calls, process creation and credential-file reads. Caller-supplied
environment placeholders are still validated by the runtime loaders. No grants,
RLS, Vault readiness, restoration, clinical, native or capacity result is supplied.

Optional document-set `provisioning` examples use the existing provisioning
parseSpec/checkBatch and admin parseArgs/endpoint/provisionRows/seedRows logic.
A REST example is `{version:1,interface:'rest',mode:'direct-alias',specs:[...]}`.
A CLI provision example is `{version:1,interface:'cli',mode:'direct-alias',args:[...]}`;
its fixed listener environment may contain ADMIN_HOSTNAME and ADMIN_PORT.
`canonical-internal` is the other runtime mode. If `--seed` is selected, `seed`
is carried JSON/CSV text; only a private scratch copy is read by actual seedRows.
No referenced host file, HTTP request, provider, provisioning object or secret
sink is opened. Removal/inspect/ensure/reset are separate operator operations;
these examples certify provisioning input conformance only. CLI seeds retain
actual batching semantics; invalid individual specs and duplicate REST batches
refuse checking. Results contain counts and fixed refusal metadata, not values.

Checker limits are instrument bounds, not a new role or deployment sizing policy:
256 MiB input bytes, one million traversed JSON nodes, depth 64, 4096 process rows,
32 carried files and 512 environment keys per process, 64 findings per validation,
and 4 MiB result output. Input file size is checked before reads, stream input is
read only through the byte ceiling, and non-JSON/cyclic/accessor library graphs
refuse before serialization or file amplification. A caller must supervise stdin
EOF/deadline; the existing CLI fixture does so. Unknown schema paths and parser
errors are redacted. No environment value or raw error/stack is reported.

This publication does not remove core deployment helpers, convert remaining
static fixtures, enable optional authcache, implement ensure/reset, or replace
any of the five deployment helper comparisons. Prospective deployment consumption
must run beside its existing source/tree/image custody checks. Source selection,
paired images and comprehensive acceptance remain coordinator-owned.
