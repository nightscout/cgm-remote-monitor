# Synthetic multitenant deployment credentials

This is an opt-in, one-host demonstration with synthetic tenants. Its application
roles run separately and use a fixed private Unix-socket participant manifest.
The deployment is not production admission, a capacity measurement or an OIDC
implementation. Source parser checks do not establish effective native SQL grants.

## Provisioning and restart

`node deploy/multitenant/bootstrap.js` is a **one-shot operator command**. It requires:

- `NS_COMPOSE_BOOTSTRAP=1`, `NS_BOOTSTRAP_OUTPUT=/state`, and the exact image
  `NS_SOURCE_COMMIT` (40 hexadecimal characters).
- `NS_POSTGRES_PASSWORD_FILE` pointing to the private administrator password, or
  an explicitly supplied `NS_BOOTSTRAP_POSTGRES_URL`. The dedicated database is
  `nightscout_compose_test`; other database names refuse.
- `VAULT_ADDR=https://vault:8200` and `NODE_EXTRA_CA_CERTS=/run/ns-ca/ca.crt`.

The command initializes/unseals the demo Vault with one share/one threshold,
creates fresh restricted PostgreSQL logins and a separate NOLOGIN object owner,
executes the actual reviewed catalogue migrations, grants exact capabilities,
creates scoped tenant Transit keys/tokens and seeds synthetic tenants A and B.
Single-share unseal custody is a local demonstration convenience, not a production
Vault recovery policy. Bootstrap is the only service with the administrator
password, Vault initialization material and writable `/state` root.

A successful completion marker is tied to the exact application source. A restart
of the same image only unseals Vault; it does not replay migrations, change grants,
reset rows or replace credentials. Source drift refuses. A partial bootstrap also
refuses: inspect the failure and recreate only this demonstration's resources via
the deployment's explicit teardown, rather than adopting partial schemas.
Serving starts only after the one-shot bootstrap completes successfully. Runtime
startup remains read-only with respect to role/schema/grant preparation.

## Capability inventory

All login roles are NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE and
NOREPLICATION. They do not own application objects and cannot create schemas.
The source-generated SQL in `config.js` is the exact grant plan; no runtime role
inherits the object owner or bootstrap administrator.

| Credential | Mounted in | Capability |
|---|---|---|
| Bootstrap PostgreSQL administrator | bootstrap only | Explicit fresh schema/role/migration preparation; never runtime serving |
| Vault root/unseal material | bootstrap only | Demo initialization/unseal, scoped key/policy/token creation |
| API data | API | Supported clinical mutations; current authority reads; required secrets persistence |
| Readiness | API | Selected migration ledger reads; no application mutation |
| Alarm state | API | Narrow suppression writes/current authority reads and notification-state reads |
| Realtime reader | realtime | Clinical/clock reads and its own checkpoint-column updates |
| Evaluator reader | evaluator | Clinical/clock reads and its own checkpoint-column updates |
| Notification outbox | evaluator | Exact durable request/head/state columns; no clinical mutation |
| Suppression reader | evaluator | Suppression reads; no suppression or clinical writes |
| Owner writer | tenant-admin | Subject metadata/role links/audit and owner-fence columns; no clinical writes |
| Owner authority reader | tenant-admin | Current management access and authorization reads |
| Lifetime identity, distinct per process | corresponding API/realtime/evaluator/tenant-admin | Lifecycle operation registration/finish columns and own-backend birth function only; no clinical mutation |
| Maintenance operator | ops only | Lifecycle capture reads, clinical logical-restore writes/counters, forward clock advancement and restore control; `pg_read_all_stats` for actual backend-birth census |
| Tenant-scoped Vault tokens | API only | That tenant's decrypt/HMAC/verify/data-token signing paths; no management signing or root authority |
| nginx/UI | neither gets database or Vault credentials | Public routing and presentation only |

Each lower identity receives only lifecycle window/operation/ledger reads, so all
actual database handles can participate in the maintenance protocol. Lifetime
credentials are independent of those lower handles and cannot mutate application
data. The maintenance operator has active restore authority for tenant A only;
its SQL privilege does not confer tenant B restore authority.

The object owner is NOLOGIN and owns each schema, table and trigger function.
Ordered collections use tenant-local forced-RLS counter rows, column-level INSERT
and invoker triggers. API cannot explicitly assign insertion ordinals. Only the
maintenance restore profile receives that capability and counter deletion.

## Files and transport boundaries

`/state/<role>/{env.json,config.json,operation.json}` belongs to runtime UID/GID
1000 by default (`NS_RUNTIME_UID`/`NS_RUNTIME_GID` override it). Directories are
0700 and private files 0600. Mount only one role directory read-only at
`/run/ns-config`; never mount the whole generated state tree into a runtime role.
API additionally needs its read-only evaluator metadata and admission documents;
realtime needs its admission document. Those documents reference credentials but
contain no evaluator outbox/suppression password in the API directory.

The UI gets only `/state/ui/config.json`: aliases and presentation theme, with
no stable tenant IDs, credentials or connection addresses. `/state/ops` contains
private per-tenant demo tokens and the operator configuration. Do not commit or
publish generated files or copy them into the image.

Bootstrap initialization material stays root-owned in `/state/bootstrap`. TLS
runtime mounts contain only the CA certificate; the Vault server alone receives
its private TLS key. Private sockets under `/run/ns-ipc` require a real 0700
same-UID directory; socket files use the product transport's private permissions.
A configured participant endpoint is not a substitute for filesystem isolation.

The demo participant roster is fixed. Restart/lost acknowledgement keeps tenant A
closed until the actual restore protocol permits reactivation. Advisory locks and
the backend census cover participating processes; they do not authenticate or
exclude arbitrary raw clients holding a stolen database credential. The demo
must not expose PostgreSQL, Vault, private control sockets or administrator
credentials through nginx.

## Login and credential lifetime

Generated `ops/tenants.json` contains valid synthetic legacy subject tokens for
the actual existing browser/data protocol. Management tokens are independently
signed under per-tenant management keys, purpose/audience bound and expire after
ten minutes. These are operator-issued demonstration credentials; no provider
login, human renewal or implicit management grant is claimed.

Tenant-scoped Vault tokens have a 24-hour demo TTL and are not renewable. Recreate
the disposable demo after expiry; a restart does not silently replace them.
A production deployment needs its selected secret-provider authentication and
renewal contract. Browser and OIDC/login UI design is documented separately.

## Verification boundary

`node deploy/multitenant/bootstrap.test.js` executes actual product parsers and
participant manifests using synthetic files and distinct credential references.
It refuses an omitted API notification namespace, then restores the full manifest
and passes. It also checks private output/refused overwrite, explicit bootstrap
intent, database scope, HTTPS and separated capability bundles.

Native bootstrap, effective PostgreSQL grants, Vault HTTPS, actual component
startup, browser presentation and tenant-local restore require the joined Compose
acceptance run. No source-only check promotes those boundaries.
