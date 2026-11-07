# Browser UI and public ingress

This DB-less process renders the repository's actual EJS dashboard, food editor,
profile editor and reports pages. It serves the production webpack artifacts,
startup scripts, static assets, translations and service worker from the same
application image as the API. It imports no test fixture and starts no clinical
server, database pool or credential verifier.

Run `node deploy/multitenant/ui.js` with:

- `UI_PUBLIC_CONFIG=/run/ns-config/config.json`: a read-only **public-only** file.
- `UI_HOSTNAME=0.0.0.0`, `UI_PORT=1340`: container-private TCP listener.

The public projection has exactly this shape:

```json
{"version":1,"tenants":[{"aliases":["one.example.test"],"theme":"default"},{"aliases":["two.example.test"],"theme":"modern"}]}
```

Aliases contain no port and must be unique. The only permitted theme values are
`default` and `modern`. Unknown fields, including secrets and connection strings,
refuse startup. An unrecognized Host receives HTTP 421. The projection selects
only the server-rendered HTML theme; restart the UI after changing it. Current
tenant settings, identity and clinical records still come through the existing
API/realtime protocol and its current-authority checks. No credentials are mounted
in this component or embedded in rendered pages. The existing browser
credential/token interface remains available; this process adds no OIDC routes.

The enabled page routes are `/`, `/food`, `/profile` and `/report`. Serving their
real HTML does not broaden the API's admitted operations. `/admin`, split frames,
clock pages and tenant-management pages are outside this initial UI mount.

Startup requires all production app, clock, food, profile and reports bundles.
Missing artifacts fail startup. Build the image from the same source checkout;
do not reuse a peer worktree's bundle cache.

## nginx

The supplied configuration listens on container port 8080. Compose publishes only
that port, on loopback by default or an explicitly configured existing private
host interface such as `169.254.1.1`. It does not create host interfaces.

- `/api` and `/api/…` go to `api:1337`.
- `/socket.io/…`, including polling, browser client download and WebSocket
  upgrades for all Socket.IO namespaces, go to `realtime:1339`.
- Page and asset requests go to `ui:1340`.

The public Host is preserved for **direct-alias** tenant resolution. Supplied
forwarded/internal-selector headers are stripped; this configuration does not
establish canonical-ingress trust. Application credentials are forwarded only to
the responsible API/realtime handler. Request logging is disabled because legacy
browser links may include credentials. Public management/operator paths are not
proxied to tenant-admin or the restore controller. Keep those components on
private listeners/networks and mount private Unix sockets only in their actual
participants.

`/healthz` is a private UI container probe and is blocked at nginx. Its success
means the public projection and production bundles loaded, not that API,
realtime, database or tenant restore is healthy. The reference HTTP ingress is
for local synthetic demonstration; production certificate and trusted-edge
configuration retain their own acceptance.

## Focused verification

After installing this checkout's locked dependencies and building its production
bundle, run:

```bash
node node_modules/mocha/bin/mocha.js --fail-zero --timeout 5000 tests/compose-ui.test.js
```

The suite renders actual shipped pages and exercises real Express routing without
opening a listener. Native nginx, browser, Socket.IO and cross-process restore
acceptance belong to the joined deployment run; source tests do not establish
those results.
