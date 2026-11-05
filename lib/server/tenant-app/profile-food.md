# Profile and food collection ports

`profile.js` and `food.js` export trusted Collection options factories:

```js
factory({ connection, table, bus, env, source: 'v3' })
```

For legacy wrappers construct a separate port with `source: 'v1/internal'`,
return it from `ctx.storagePorts.resolve({ logical, source })`, and construct
the shipping `lib/server/profile` or `lib/server/food` wrapper. No raw driver
handle is exposed by an injected wrapper. Use the existing API parent with
the explicit domain subset, and API2's compatibility-only inherited mount.
API3 consumes the factory's options through the existing `Collection`.

Apply the reviewed `migrations/candidates/postgres-profile-v1.json` and
`postgres-food-v1.json` catalogues through the operator migration runner, each
in its own explicit namespace. Runtime construction performs no migrations.
Pass the resulting qualified table names. The application role must be
`NOSUPERUSER NOBYPASSRLS`, must not own these tables, and needs DML privileges.
Food additionally needs sequence privileges for `insertion_ordinal`.
Identity keys retain ObjectId versus string kind; neither table is tenant
owner configuration.

Legacy profile ordering/pruning remains `startDate DESC, _id DESC` with the
shipping mixed-type comparisons. API3 uses its distinct `created_at`
fallback. Food's legacy unbounded lists use insertion order, including after
edits; quickpick ordering/filtering remains in the shipping wrapper.
Unknown representable JSON is stored without a field registry. Submitted
nonrepresentable documents are 400, recognized backend outages are 503,
and internal failures remain 500. The shared write intent owns the complete
transaction and announces its intent event only after commit.

`tests/tenant-rest-profile-food.integration.test.js` runs the actual legacy
parents/routers and API3 handlers against PostgreSQL/RLS, persisted authority
and credential metadata, real Vault Transit and a MongoDB differential.
It requires the explicit `NS_PROFILE_FOOD_HTTP_TEST=1` opt-in and disposable
PostgreSQL/MongoDB/Vault connection environment. The test is not runtime
admission: the integrator must mount and verify these domains explicitly.
