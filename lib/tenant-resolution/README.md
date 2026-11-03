# Tenant resolution boundary

This opt-in service does not install middleware, bind tenant scope, authorize a
caller, or enable any serving role. Existing single-tenant paths do not use it.

```js
const createResolver = require('./lib/tenant-resolution');
const resolver = createResolver({
  aliases: [
    { host: 'alias-one.example.org', tenant: 'tenant_42' },
    { host: 'alias-two.example.org', tenant: 'tenant_42' }
  ]
});
const tenant = resolver.resolve(request);
```

`aliases` is an operator-owned list, copied and checked at construction. Multiple
public aliases may point to the same stable, opaque internal identity. Alias
rotation needs no identity change. No backend address or hostname-derived tenant
identity is stored. Construct a new resolver to replace the mapping.

The request must provide Node's original `rawHeaders`; normalized headers alone
cannot show duplicate Host fields. Only ASCII DNS names are supported, with an
optional port (1–65535). Matching ignores case and port. IP literals, trailing
dots, whitespace, lists, URLs, and invalid DNS labels are rejected.

Proxy headers are rejected by default. An optional synchronous
`trustedProxy(request)` predicate must return exactly `true` before either
`X-Forwarded-Host` or `X-Resolved-Tenant` is accepted. The operator must base this
decision on an authenticated transport or trusted peer, not caller headers.
The edge must remove caller-supplied proxy headers and set its own. An approved
`X-Forwarded-Host` supplies the public alias when Host names the app backend.
Host must still be present and well formed.

`X-Resolved-Tenant` is an optional internal handoff assertion: it must equal the
identity mapped from the public alias. It cannot replace a known public alias,
create a tenant, or grant access. This keeps the handoff tied to the same
operator mapping, not to the app backend location. Unknown aliases, duplicate
selector fields (even equal ones), comma lists, and conflicting identities fail
closed. There is no default tenant. Errors have stable `TENANT_*` codes and do
not include selector values. Authentication and authorization remain separate.
