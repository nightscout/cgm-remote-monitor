# Proxy configuration (`TRUST_PROXY`)

> This branch (bf2/auth-hardening) differs from chore/nightscout-modernization
> in how the default resolves client identity; see "Client identity" below.

The production Kubernetes trial exposed redirect loops from the initially
mandatory proxy-IP configuration. That migration is superseded: existing
TLS-terminating proxy installations retain compatibility without enumerating
changing ingress pod addresses. No additional environment variable is required.

## Modes

| `TRUST_PROXY` | Behavior |
| --- | --- |
| Unset or empty | Compatibility: honor forwarded protocol/hostname and legacy client-IP headers from the connecting peer. |
| `false` | Direct-only: ignore forwarded metadata; use the socket peer and actual TLS connection. |
| Comma-separated IP addresses/CIDRs | Restricted trust: only configured proxy peers supply forwarded metadata; walk `X-Forwarded-For` from right to left, stopping at the first untrusted address. |

`true`, hop counts, subnet aliases and malformed settings are rejected at startup.
The existing `CUSTOMCONNSTR_TRUST_PROXY` environment convention also works.
An explicitly configured list never falls back to compatibility for unknown peers.

## Compatibility boundary

The default restores the previous edge-managed trust model, not the spoofing
protections of the earlier default-direct modernization candidate. The proxy
must overwrite untrusted forwarded headers and control access to the backend.
Publicly reachable clients must not be able to bypass that boundary and supply
trusted metadata. Direct-facing installations should use `TRUST_PROXY=false`.

HTTPS detection uses Express's forwarded protocol handling. With
`INSECURE_USE_HTTP=false` (the default), proxied HTTPS requests proceed, while
plain HTTP without an HTTPS indication still redirects. Disabling Nightscout's
HTTPS enforcement is not necessary to solve the ingress redirect loop.

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

**Failed-login throttling.** Nightscout delays repeated failed logins, counted
per client address. In the default mode that address is whatever the forwarding
headers say, so a caller who changes them on every attempt is never delayed.
The delay only protects against password or token guessing once `TRUST_PROXY`
is set (to `false`, or to your proxy's addresses); Nightscout logs a warning at
startup while it is unset.

## Deployment guidance

- **Kubernetes / ingress-nginx:** existing sanitized HTTP forwarding behind TLS
  termination works with the default, including ingress pod replacement. Keep
  backend access controlled, for example with enforced network policy selecting
  the ingress namespace/pods. Do not infer a trusted cluster CIDR from a pod list.
- **Docker, nginx/Apache, Heroku and Azure:** existing edge-managed proxy setups
  can use the compatibility default without guessing provider address ranges.
- **Restricted trust:** use verified proxy source addresses/CIDRs as seen by
  Nightscout. Account for intermediate proxies, source NAT and address rotation.
  A stable dedicated proxy network may be appropriate; arbitrary shared pod or
  client networks are not equivalent to a proxy-only trust boundary.

Restricted mode accepts only `X-Forwarded-For` for client identity. Alternate
headers, malformed addresses and port-bearing values do not bypass its policy.
Express HTTPS/hostname metadata and raw HTTP/API3/Socket.IO client resolution use
one configured trust policy. In compatibility mode the legacy client headers
can differ from Express's `req.ip`, which uses `X-Forwarded-For`.

## Validation

`tests/client-ip.test.js` covers compatibility, explicit direct mode, CIDR trust,
changing ingress peers, header precedence, malformed chains, IPv4/IPv6/ports,
HTTPS redirects, independent authentication-delay keys and HTTP/API3/Socket.IO
consumers. Environment tests cover unset, empty, false, lists and Azure aliases.

Check real deployment login, status/API3, client identity and Socket.IO after
rollout. Automated fixtures do not establish a deployment's actual trust boundary.
Rollback of this compatibility correction restores the mandatory explicit-IP
candidate behavior, including redirect loops on unconfigured TLS proxies.

Reference: [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/).
