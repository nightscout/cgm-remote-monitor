# Tenant REST context ports

These factories construct services and routers; they do not enable a listener,
run migrations, or admit routes. The integrator must supply current-authority
authentication, tenant scope and explicit completed collection registrations.

* `environment({settings, extendedSettings})` builds a new display environment
  from typed client allowlists and the typed plugin extended settings
  (`EXTENDED`). It does not copy an application context, process environment,
  provider configuration, credentials or arbitrary nested settings. The status
  route shows a tenant's carried extended settings, as a single site does. `rest-context` and `snapshot` require an environment from this
  factory.
* `rest-context({env, authorization, collections, versionInfo, admitted,
  statusAuthorization})` returns `legacy`, `v2`, `v3` and `root` routers.
  `authorization` is the tenant-bound legacy middleware; `collections` contains
  only completed, request-bound API3 collections. `versionInfo` supplies explicit
  `name`, application `version` and `{storage, version}` metadata. `admitted`
  maps version numbers to completed collection names. The optional asynchronous
  `statusAuthorization(req)` issues tenant authorization material through the
  tenant exchange; its default issues nothing. Legacy status retains no-store
  and its format negotiation. API3 status and modification discovery use
  actual authorized collection ports, never the configured six-collection list.
* `status-authorization({tenant, exchange})` supplies that status callback using
  the tenant exchange. It preserves shipping issuance precedence: a validated
  extracted token, then header secret, then query secret. Permission
  authentication has different secret precedence; a consumed body secret does
  not itself issue status authorization material. The extraction helper retains
  selected credentials only for the lifetime of that request, including body
  tokens consumed before an inherited v2 status handler runs.
* `settings({connection, table, bus, env})` returns API3 Collection constructor
  options over the shared PostgreSQL document intent. Apply the separate
  `postgres-settings-v1.json` candidate explicitly. Settings documents retain
  generic CRUD/history and strict-read behavior; they are not owner
  configuration, rollback or secret records.
* `snapshot({tenant, env, language, ports}).load({at})` runs the shipping
  dataloader and normalizers with a fresh private ddata, cache and bus.
  The six required ports are `entries`, `treatments`, `devicestatus`, `activity`,
  `profile` and `food`, each `{tenant, store}` with the shipping `list` method
  (`last` for profile). `stats` is `{tenant, read}` and must return tenant-only
  `dataSize`/`indexSize`, not database-wide statistics. An unmeasured tenant
  index-size attribution may be absent, never replaced with database-wide bytes.
  Missing or crosswired
  ports and individual loader failures refuse; no empty-data substitute is
  supplied. Historical frames are loaded as frames, not from a live cache.

Snapshot service availability does not admit properties, ddata or summary:
those routes require a completed domain join and their own HTTP comparison.
Subject/role administration, process notices, notifications and assistant
integrations are not supplied by these factories.

`tests/tenant-rest-context.integration.test.js` runs the normalizer/isolation
checks normally. Its HTTP portion additionally requires
`NS_REST_CONTEXT_HTTP_TEST=1`, an explicitly owned disposable
`NS_TEST_POSTGRES_ADMIN_URI`, and `CUSTOMCONNSTR_mongo`. It prepares isolated
schemas/application privileges, uses real Vault Transit on an owned random
loopback port, and removes only its own fixtures. It does not use ambient
databases when the opt-in is absent.
