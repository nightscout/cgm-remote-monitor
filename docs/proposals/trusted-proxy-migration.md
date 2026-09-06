# Trusted proxies in Nightscout 15.0.9

M22 policy approved: reverse proxies must be explicitly trusted. With
`TRUST_PROXY` unset, Nightscout uses the connected peer's address and ignores
forwarded client-IP, protocol and hostname metadata. This is an intentional
change from the permissive behavior in 15.0.8.

## Configure before upgrading

Set `TRUST_PROXY` to a comma-separated list of the IP addresses or CIDRs of the
proxies between the client and Nightscout. For example, a proxy on the same host
connecting over loopback can use `TRUST_PROXY=127.0.0.1,::1`. Only use that example
when the connected peer actually is the trusted local proxy. Booleans, hop
counts and named subnet aliases are rejected; a malformed setting prevents
startup. An empty setting trusts no proxy.

The edge must overwrite untrusted `X-Forwarded-For`, `X-Forwarded-Proto` and
`X-Forwarded-Host` values. Additional trusted proxies append their observed peer
to the IP chain. Nightscout walks `X-Forwarded-For` from right to left, starting
at the connected peer, and stops at the first untrusted address. Do not trust
client networks or every address: that would restore spoofable client metadata.
Restrict direct access to the backend where the deployment requires a proxy.

Use bare IPv4 or IPv6 addresses in `X-Forwarded-For`, including IPv4-mapped IPv6
where applicable. Port-bearing values (such as `192.0.2.1:1234` or
`[2001:db8::1]:1234`), quoted addresses and invalid values are unsupported;
Nightscout falls back to the socket peer for authentication throttling if the
selected address is invalid. Configure the edge to remove ports. `Fastly-Client-IP`,
`X-Real-IP`, `Z-Forwarded-For` and RFC `Forwarded` are no longer alternate inputs.
If a provider uses those headers, normalize its verified client address into
`X-Forwarded-For` at the trusted edge. Never copy arbitrary client-supplied values.

## Deployment examples and checks

- **Local nginx/Apache:** when the proxy connects from loopback, use
  `TRUST_PROXY=127.0.0.1,::1`. Configure the proxy to set the forwarded protocol
  from its actual TLS connection and emit a bare client IP. Verify HTTPS requests
  do not redirect repeatedly and direct HTTP still redirects.
- **Docker:** use the actual address of the proxy container, or a dedicated
  proxy-only network CIDR. For example, if the controlled proxy is assigned
  `172.30.0.2`, use `TRUST_PROXY=172.30.0.2`. This address is illustrative, not a
  Nightscout default. Do not copy an arbitrary Docker subnet or trust every
  container sharing an application network. Do not publish the backend port
  publicly if access is intended exclusively through the proxy.
- **Heroku:** set the `TRUST_PROXY` config var to verified router peer addresses
  or ranges for the deployment. Do not guess a private range or substitute
  `true` or a hop count. If the platform cannot provide a stable, enforceable
  trust boundary, validate an ingress arrangement with explicit trusted peers
  before upgrading. A generic safe router CIDR is not supplied by this change.
- **Azure:** set `TRUST_PROXY` in application settings (the existing
  `CUSTOMCONNSTR_TRUST_PROXY` environment convention also works). Use verified
  ingress peer addresses/ranges, including every trusted intermediate hop.
  Confirm whether the ingress emits ports and normalize them before Nightscout.
  As with Heroku, no platform-wide CIDR is assumed.

On each hosting target, check login/token authentication, failed-login backoff,
status requests, API v3 and Socket.IO polling plus WebSocket reconnection. Verify
that altering forwarded headers on an untrusted direct request cannot change its
client identity or mark plain HTTP as HTTPS. A missing trust setting on a TLS
terminating proxy can cause redirect loops and group users under the proxy's
throttle key. Configure trust correctly instead of disabling HTTPS enforcement
to conceal that problem.

## Implementation and validation

All six former `forwarded-for` consumers use one helper built on `proxy-addr`,
already required by Express and now explicitly declared. The old dependency is
removed. The main Express application and both API sub-applications use the same
configuration; raw Socket.IO requests use it without relying on Express getters.
The HTTPS redirect now uses `req.secure`, with the same trust boundary.

`tests/client-ip.test.js` covers spoofing, multi-hop trust, IPv4/IPv6, invalid and
port-bearing values, repeated requests, independent policies, actual HTTP and
Socket.IO transports, authentication delay keys and the Nightscout HTTPS
redirect. Existing security-header tests explicitly trust their local test edge.
Full CI and actual hosting validation remain separate from these owned fixtures.
There is no UI redesign; deployment configuration and authentication behavior
are affected. No runtime memory saving is claimed.

Reference: [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/).
