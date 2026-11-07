# Single-host multitenant Compose demonstration

This explicit synthetic deployment runs API, realtime, evaluator, tenant-admin
and the shipped web pages in separate containers. nginx presents one browser
origin. PostgreSQL and TLS-enabled Vault stay on the private network. It does
not change `nightscout single` or the existing Mongo Compose deployment.

The deployment uses synthetic tenants and generated private credentials. Keep
real records and identities out of this demonstration. Native deployment
acceptance is pending; source checks do not establish restore acceptance.

## Prepare and start

Requirements: Docker Engine with Compose v2, Node.js, OpenSSL, and a host user
with uid/gid 1000 matching the image's `node` account. Use a dedicated checkout.
The image builds the production webpack bundle from that checkout's lockfile.

```bash
cd deploy/multitenant
./demo.sh prepare
node check-compose.js
./demo.sh build
./demo.sh bootstrap
./demo.sh up
./demo.sh status
./demo.sh demo
```

`bootstrap` is a deliberate one-shot operation, not an application startup hook.
It prepares the schema, grants and synthetic tenant configuration before roles
can pass their own read-only admission checks. `up` repeats the bootstrap entry
point for its supported restart/unseal handling; it must refuse partial setup
instead of adopting unknown existing schemas.

The default public binding is `127.0.0.1:18080`. Add local name resolution for
the synthetic aliases declared in the generated public UI config, then use that
hostname in the browser. The two aliases select separate tenants at the same
origin port. Read the generated private operator environment only when you need
the synthetic browser token; keep it out of shell history, screenshots and logs.

To use an **already configured** dummy interface instead:

```bash
./demo.sh prepare --bind 169.254.1.1 --port 18080
```

Preparation verifies that the address exists; it never changes interfaces or
routes. Choose this before initial preparation. The directory and `.env` must
not already exist. nginx is the only published service. Container loopback is
private to that container; other services communicate over the internal Docker
network or the fixed private Unix socket paths.

## Credentials and initialization

Each runtime service mounts only its own generated read-only configuration
directory. The UI and nginx receive no database credentials. Only the one-shot
bootstrap mounts the full private output directory and initial database/Vault
material. The separate operator demonstration mounts only its operational
configuration, artifact directory and participant sockets.

Vault's server certificate is issued by a local, short-lived demo CA. Runtime
containers receive the public CA certificate; the signing key and Vault
initialization material stay in the private host state. This lab uses a
single-share Vault initialization ceremony. Use your deployment's established
key custody and recovery process for real operation.

The schema owner, migration identity, read-only readiness identity, clinical API
writer, realtime reader, evaluator durable-state capabilities, owner management
and maintenance operator have different responsibilities. See `CREDENTIALS.md`
for the actual generated privilege inventory. A runtime service must never reuse
the bootstrap administrator. PostgreSQL RLS remains enabled for serving roles.

The database and Vault use named volumes. nginx has no route to platform-admin,
tenant-admin or restore-control endpoints. Tenant management is initially
available only through the private service boundary. Private Unix sockets use a
shared uid, mode-0700 directory and mode-0600 endpoints; only the participating
roles and maintenance operator mount that directory. This is fixed single-host
composition, not dynamic replica discovery.

## Tenant-local restore demonstration

`demo.sh demo` exercises the actual REST and lifecycle/controller modules. The
intended observation is: capture A, alter A, restore A through the participating
services, observe B completing an independent write while A is held, and verify
restored A plus forward history corrections without changing B's prior state.
The operator must retain the actual source's transaction, authority and clock
checks. An uncertain outcome or missing participant must refuse; do not clear
maintenance state or force reopening to make the demonstration finish.

Artifacts remain in the private state directory. They include synthetic
clinical records and metadata; do not commit generated state or credentials.

## Web UI and human login

The UI service renders the shipped templates and serves the production browser
bundle. The existing browser talks to same-origin API and Socket.IO routes.
The UI service does not query PostgreSQL or decide a user's authority. Tenant
public configuration is a narrow validated projection, not an exported runtime
environment. Editor pages do not imply that every operator/integration feature
has been admitted in the preview.

Shared optional OIDC for single and multitenant modes is an independent feature.
Its login/callback/session integration is not implemented by this Compose file.
Both modes should use the same provider protocol with their own current local
authorization adapters. Existing machine credentials remain compatible.

Recommended responsibility split: Nightscout provides its sign-in entry point,
callback/session/logout handling and permission mapping; an interchangeable
identity provider supplies sign-in, MFA and account recovery screens. A service
provider may supply its own identity UI through that provider contract. A
first-party password/recovery UI is not required. Authentik can be a self-managed
OIDC reference; Clerk can be a managed option. Neither is a mandatory dependency
or accepted adapter in this demo. Provider authentication alone must never grant
tenant membership or management authority.

## Stop and retain evidence

```bash
./demo.sh stop
./demo.sh down
```

These commands retain data volumes and private state. Delete them only after
checking the exact project and saving any wanted synthetic evidence. A stopped
Vault must be unsealed before runtime roles start again. Do not delete sockets
while participating services are running. The initial demo CA expires after
30 days; rebuild a fresh synthetic instance rather than disabling verification.
