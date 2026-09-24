# Proxy configuration (`TRUST_PROXY`)

> This branch (bf2/auth-hardening) differs from chore/nightscout-modernization
> in how the default resolves client identity; see "Client identity" below.

`TRUST_PROXY` tells Nightscout which proxies in front of it to believe when it
works out a client's address and whether a request arrived over https. The
default (unset) behaves as every earlier release: existing TLS-terminating proxy
installations keep working without any new variable. Setting it is what makes the
failed-login delay effective; see "Failed-login delay" and "Which setting for
which deployment" below.

## Modes

| `TRUST_PROXY` | Behavior |
| --- | --- |
| Unset or empty | Compatibility: honor forwarded protocol/hostname and legacy client-IP headers from the connecting peer. |
| `false` | Direct-only: ignore forwarded metadata; use the socket peer and actual TLS connection. |
| Comma-separated IP addresses/CIDRs | Restricted trust: only configured proxy peers supply forwarded metadata; walk `X-Forwarded-For` from right to left, stopping at the first untrusted address. |
| A whole number `n` (1 or more) | Hop count, as Express's numeric `trust proxy`: trust the `n` closest hops; the client is the `X-Forwarded-For` entry added by the proxy `n` hops away. |
| `true` | Trust every hop, as Express's `true`: the client is the left-most `X-Forwarded-For` entry, so it is only as trustworthy as the outermost proxy, which must replace a client-supplied header rather than add to it. This is not the compatibility default. |

`0`, negative or fractional numbers, numbers mixed with addresses, subnet aliases
and malformed settings are rejected at startup.
The existing `CUSTOMCONNSTR_TRUST_PROXY` environment convention also works.
An explicitly configured list never falls back to compatibility for unknown peers.

What each mode logs once at startup (from `lib/authorization/delaylist.js`):

| `TRUST_PROXY` | Level | Message begins |
| --- | --- | --- |
| Unset or empty | warning | `SECURITY: failed-authentication throttling is keyed on the client address, and TRUST_PROXY is not set, so that address is read from request headers (X-Forwarded-For and similar) that any caller can set. …` |
| `true` | warning | `SECURITY: failed-authentication throttling is keyed on the client address, and TRUST_PROXY=true trusts every proxy hop, so that address is the left-most X-Forwarded-For entry. …` |
| A whole number `n` | info | `Failed-authentication throttling is keyed on the client address as resolved through TRUST_PROXY=n: the X-Forwarded-For entry added by the proxy n hop(s) from Nightscout.` |
| `false` or a list | info | `Failed-authentication throttling is keyed on the client address as resolved through TRUST_PROXY=<value>.` |
| Invalid | Nightscout does not start | `TRUST_PROXY must be false, true, a whole number of proxy hops (1 or more), or a comma-separated list of proxy IP addresses or CIDRs`, followed by the specific problem |

To undo any setting, remove `TRUST_PROXY` (or set it empty) and restart.

## Compatibility boundary

The default restores the previous edge-managed trust model, not the spoofing
protections of the earlier default-direct modernization candidate. The proxy
must control access to the backend: publicly reachable clients must not be able
to bypass it. The failed-login delay is protected only when `TRUST_PROXY` is set
to match the deployment. Direct-facing installations should use
`TRUST_PROXY=false`.

HTTPS detection uses Express's forwarded protocol handling. With
`INSECURE_USE_HTTP=false` (the default), proxied HTTPS requests proceed, while
plain HTTP without an HTTPS indication still redirects. Disabling Nightscout's
HTTPS enforcement is not necessary to solve the ingress redirect loop.

The forwarded protocol is believed only when the connecting peer is trusted:
always when unset, with `true`, and with a hop count; with a list, only when the
peer is in the list. So behind a TLS-terminating proxy, `TRUST_PROXY=false`, or a
list that does not contain the proxy's actual address, makes every request look
like plain HTTP and Nightscout redirects forever. The fix is the right value, not
`INSECURE_USE_HTTP=true`; removing `TRUST_PROXY` restores the earlier behaviour
at once.

Client identity in the default mode is resolved exactly as in earlier releases,
by the `forwarded-for` package, which reads the header families
`Fastly-Client-IP`, `X-Forwarded-For`, `Z-Forwarded-For`, `Forwarded` and
`X-Real-IP`. The first family present wins; its comma-separated chain must
contain valid IP addresses throughout, and its first address is the client.
Invalid chains fall back to the socket peer. Here `Forwarded` means the legacy
bare-IP header, not RFC `for=...` syntax. Two properties of the old behaviour
are kept deliberately, because the default must not change what existing
installations see: the search order is reordered by earlier requests (the
family that last matched moves to the front), and an IPv6 address after the
first entry in a comma-and-space chain makes the chain invalid. (The
modernization branch replaces this with a fixed-order reimplementation.) Edges
using any of these headers must strip or overwrite the others when clients
supply them.

## Failed-login delay

`AUTH_FAIL_DELAY` (milliseconds, default `5000`). Each failed API secret or
token check adds that delay under two keys: the client address, and the
credential that was tried. Repeated failures extend the delay from its current
end. A successful check clears both keys.

The wait comes **before** the credential is checked, as in every earlier
release (`lib/authorization/index.js` `resolve()`). Any request whose address or
credential has a pending delay waits for the longest one first, and only then is
its credential checked. That includes requests with the correct credential and
requests with no credential at all. A correct guess made during a delay is
therefore not answered any faster than a wrong one.

What that costs depends on the address:

- **Correct address** (`TRUST_PROXY` matches the deployment): only clients that
  really share a public address share a delay: devices on one home network, or
  phones behind a mobile carrier's shared address. Example: a caregiver's phone
  on the same Wi-Fi as an uploader still configured with an old `API_SECRET`
  waits on every request while that uploader keeps failing. The credential key
  also follows the old secret wherever the uploader connects from. Fixing the
  uploader's secret ends the waits.
- **Proxy's address** (`false` behind a proxy, a hop count that is too small, or
  a proxy that does not add the client to `X-Forwarded-For`): every client
  shares one address, so one failing uploader slows every viewer and every other
  uploader.
- **Unset:** the address comes from forwarding headers that any caller can set,
  so a caller who changes them, and the password or token tried, on every attempt
  is never delayed. The delay does not protect against guessing, and Nightscout
  logs a `SECURITY:` warning at startup. With `true` behind a proxy that appends
  to a client-supplied header, the same applies, and the `true` warning says so.

## Deployment guidance

The default keeps every existing proxy setup working. It does not make the
failed-login delay effective behind any of them; a hop count or an address list
does. Where a trusted proxy or load balancer adds its entry to an
`X-Forwarded-For` header the caller may already have filled in, which is what
nginx's usual `$proxy_add_x_forwarded_for`, Apache, HAProxy's `option
forwardfor` and Heroku's router do, counting hops back to that trusted proxy is
what separates the real client from whatever the caller wrote.

- **Kubernetes / ingress-nginx:** `TRUST_PROXY=1` when the ingress forwards
  straight to Nightscout, and it survives ingress pod replacement. Keep backend
  access controlled, for example with enforced network policy selecting the
  ingress namespace/pods. Do not infer a trusted cluster CIDR from a pod list.
- **Docker, nginx/Apache, Caddy, Traefik, HAProxy, Heroku:** `TRUST_PROXY=1`
  for one proxy, without listing provider address ranges. See the table below
  for platforms that put more than one proxy in front.
- **Azure App Service:** leave `TRUST_PROXY` unset for now. Azure is reported
  to send the client as `address:port`, which every explicit mode rejects in
  favour of the peer, so an explicit value gives every client the same address.
- **Restricted trust:** use verified proxy source addresses/CIDRs as seen by
  Nightscout. Account for intermediate proxies, source NAT and address rotation.
  A stable dedicated proxy network may be appropriate; arbitrary shared pod or
  client networks are not equivalent to a proxy-only trust boundary.

Restricted mode accepts only `X-Forwarded-For` for client identity. Alternate
headers, malformed addresses and port-bearing values do not bypass its policy.
Express HTTPS/hostname metadata and raw HTTP/API3/Socket.IO client resolution use
one configured trust policy. In compatibility mode the legacy client headers
can differ from Express's `req.ip`, which uses `X-Forwarded-For`.

## Which setting for which deployment

Recommendations as of 2026-09-24. Hosted-platform rows come from the platforms'
documentation and public reports, not from measurement; confidence is given for
each. Self-hosted rows were measured on 2026-09-24 in a local lab with real
proxies (nginx appending and replacing, two nginx hops, Caddy, Traefik, HAProxy,
a TLS terminator, and a PROXY-protocol load balancer in front of two nginx hops):
with the hop count set to the trusted proxy, each resolved the real client and
ignored forwarded headers the client sent.

| Deployment | `TRUST_PROXY` | Confidence | Notes |
| --- | --- | --- | --- |
| No proxy: Nightscout serves TLS itself, or plain HTTP on a home network | `false` | high | A hop count or `true` here would treat any caller as a proxy. |
| One proxy on the same host or compose network (nginx, Apache, HAProxy, Caddy, Traefik) | `1` | high | nginx must set `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (or `$remote_addr`). With no such line nginx forwards a client's header unchanged and adds nothing, and any explicit value then believes it. Apache must also send `X-Forwarded-Proto` (`RequestHeader set X-Forwarded-Proto "https"`). HAProxy must not use `forwardfor if-none`. A list such as `127.0.0.1` also works when the proxy's address is fixed. |
| Shipped `docker-compose.yml` (Traefik) | `1` | high | Traefik's container address changes, so do not list it. The compose file sets `INSECURE_USE_HTTP: 'true'`, so `false` does not loop there, but it gives every client Traefik's address. |
| Cloudflare proxy, then one local proxy | `2` | high | Or a list: the local proxy's address plus Cloudflare's published ranges (<https://www.cloudflare.com/ips/>). A hop count is only safe if the origin accepts connections from Cloudflare alone. |
| Cloudflare Tunnel straight to Nightscout / via one local proxy | `1` / `2` | medium | |
| Heroku | `1` | high | Router appends; router addresses are not stable. |
| Google Cloud Run (run.app) / behind a global external Application Load Balancer | `1` / `2` | medium | The load balancer appends two entries. |
| Koyeb | `1` | medium | Documented as appending. |
| Railway | `1`, then verify | low | Railway staff statements conflict (append vs strip); a CDN path may add a hop. |
| Fly.io | `2`, then verify | low | Community reports only. |
| Render | `3`, then verify | low | One measured public report (a Cloudflare hop and an internal hop). |
| Northflank | `1`, then verify | low | Append/replace not documented. |
| DigitalOcean App Platform | leave unset | low | DO documents `X-Forwarded-For` as carrying the ingress address and the client in `do-connecting-ip`, which Nightscout does not read; a user report disagrees. |
| Azure App Service | leave unset | medium | Port suffix; see "Deployment guidance". |
| Kubernetes, ingress-nginx default | `1` | high | Only meaningful if the ingress sees real client addresses (PROXY protocol, or a source-preserving load balancer). Do not infer a CIDR from a pod list. |
| DigitalOcean Kubernetes, load balancer in TCP mode with PROXY protocol, ingress-nginx `use-proxy-protocol: "true"` | `1`, plus one per further proxy between the ingress and Nightscout | high | In TCP mode the load balancer adds no HTTP headers; the client travels only in the PROXY header, and the ingress rewrites `X-Forwarded-For` from it. The load balancer is not a hop; count the ingress and every HTTP proxy after it. Measured with an emulated chain: one too few gives the ingress's address, one too many believes the client. Enable PROXY protocol on both sides or neither: a mismatch takes the site down (the ingress answers 400 or drops connections), and neither side enabled leaves every client with the load balancer's address. |
| Managed Nightscout (T1Pal, NS10BE, similar) | provider's choice | — | The site owner does not control the proxy; ask the provider. |

**Choosing a hop count.** Count the proxies between Nightscout and the first
one you trust to add the real client, including that one. Too small gives every
client a proxy's address (all clients share one delay). Too large believes a value the caller supplied, and
looks correct in a simple test, because a client that sends no header still
resolves to itself. Use the smallest number at which the "Failed authentication"
admin notification, triggered by one deliberately wrong secret from a phone on
mobile data, shows that phone's public address. A CDN placed in front later adds
a hop, and the number must be raised with it.

The living per-platform matrix, with sources, is kept in the Nightscout
ecosystem alignment programme docs
(`docs/30-design/remedial/trust-proxy-deployment-matrix.md`).

## Validation

`tests/client-ip.test.js` covers compatibility, explicit direct mode, CIDR trust,
changing ingress peers, header precedence, malformed chains, IPv4/IPv6/ports,
HTTPS redirects, independent authentication-delay keys and HTTP/API3/Socket.IO
consumers. Environment tests cover unset, empty, false, lists and Azure aliases.

Check real deployment login, status/API3, client identity and Socket.IO after
rollout. Automated fixtures do not establish a deployment's actual trust boundary.

Reference: [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/).
