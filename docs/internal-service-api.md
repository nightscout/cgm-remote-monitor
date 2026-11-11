# Internal service APIs

The optional multitenant server roles use explicit internal APIs for socket
credential decisions, socket writes, notification handoff and tenant restore
coordination. A private listener serves an explicitly composed set of named
services through one fixed route table. A shared transport carries
JSON requests and responses over a Unix-domain socket or an internal HTTP
connection with explicit network trust configuration.

The roles currently open one listener per service. `transport.compose` can serve
several services on one component-private listener (see
[listener composition](#listener-composition)); role wiring has not been moved to
it. Application and lifecycle contracts are both private APIs; lifecycle is a purpose,
not a special transport. See [private API categories and deployment bindings](internal-service-topology.md#private-api-categories-and-deployment-bindings)
for the distinction between a contract, a listener and a deployable component.

The shipping single-site Socket.IO listener does not use these APIs. Unix-domain
sockets retain their existing filesystem trust model. Deployment controls who can
reach HTTP endpoints. The transport does not introduce a bearer credential
protocol.

## Service ownership and operations

The executable contracts live in
[`lib/server/internal-api/contracts/`](../lib/server/internal-api/contracts/index.js).
Their checked-in JSON documents contain each operation's path and JSON Schema
request and response. Both ends validate the serialized JSON representation, so
existing BSON ObjectId and Date `toJSON()` behavior is preserved on the wire.

See [component interfaces and traffic](internal-service-topology.md) for listener
ownership, the reference deployment and separate traffic-plane diagrams.

| Executable schema document | Request / response schema locations | Domain validation retained |
|---|---|---|
| [Socket authority](../lib/server/internal-api/contracts/socket-authority.json) | `operations.authorizeSocket.{request,response}` and `operations.executeSocketMutation.{request,response}` | Host-to-tenant matching, current credentials, exact write and acknowledgement authority. |
| [Alarm delivery](../lib/server/internal-api/contracts/alarm-delivery.json) | `operations.deliverAlarm.{request,response}` | Current tenant, notification domain rules and recipient read authority. |
| [Lifecycle participant](../lib/server/internal-api/contracts/lifecycle-participant.json) | `operations.getStatus.{request,response}` and `operations.invalidateTenant.{request,response}` | Participant census, pinned incarnation/schema/datastore/backend identities, nonce, drain and suspension rules. |
| [Connector inspection](../lib/server/internal-api/contracts/connector-inspection.json) | `operations.inspectConnectors.{request,response}` | None: a read of the vcpool member's pool state and per-tenant status, counts and upstream refusals. It carries no endpoint, credential or row. |
| [Evaluator inspection](../lib/server/internal-api/contracts/evaluator-inspection.json) | `operations.inspectEvaluator.{request,response}` | None: a read of the evaluator's configured pool values (mode, ordinal, rule, lease), observed membership (desired and effective count, live rows, heartbeat ages, conflicts), its gate, and per configured tenant the assigned ordinal, admission and progress. It never schedules work, renews a lease or changes eligibility. |
| [Pool operations](../lib/server/internal-api/contracts/pool-operations.json) | `operations.getPool.{request,response}` and `operations.setPoolMembers.{request,response}` | The admin role's configured pool kinds only; the operator's pool identity can write only the desired-count row. |

Each nested `request` and `response` is a JSON Schema 2020-12 document. The
containing document is the service registry, not itself a payload schema. Select
the appropriate nested schema when using a schema editor, validator or client
generator. Required fields, field types, enumerations and additional-property
rules are executable in these documents; they are not duplicated in a second
hand-maintained schema. A named method's `path` is the exact HTTP request target.

An operation may also declare `method` (default and only supported value
`POST`), `contentType` (default and only supported value `application/json`),
`maxBytes` and `timeoutMs`. The operation's byte and deadline bounds can only
tighten the endpoint's configured bounds; both the listener and the named client
apply the smaller value to the request and the response. A request whose media
type is not the operation's type (optionally with `charset=utf-8`) is refused,
and a client refuses a response with a different media type. An unsupported
method or media type fails registration; a GET operational/metrics module is a
separate addition, not available today. The checked-in contracts declare none of
these optional fields, so their behaviour is unchanged.

| Service | Listener owner | Named client method | POST path | Result |
|---|---|---|---|---|
| `socket-authority` | API role | `authorizeSocket(body, signal)` | `/authorize` | Current permissions and readable collections, optionally display settings; `{ "denied": true }` for a credential denial. |
| `socket-authority` | API role | `executeSocketMutation(body, signal)` | `/mutate` | Canonical socket handler callback arguments in `replyArgs`. |
| `alarm-delivery` | Realtime role | `deliverAlarm(body, signal)` | `/alarm` | `{ "accepted": true, "receipt": null, "clearedRequestIds": [] }` after realtime fanout handoff. |
| `lifecycle-participant` | Each configured serving participant | `getStatus(body, signal)` | `/cohort/status` | Participant roles, tenant set, process incarnation, schema identity, observed datastore and database backend identities. |
| `lifecycle-participant` | Each configured serving participant | `invalidateTenant(body, signal)` | `/cohort/invalidate` | Status plus the invalidated tenant, after actual role invalidators finish. |
| `ownership-operations` | Private operator plane | `listOwners(body, signal)` | `/ownership/list` | Current owners, or `denied` without an owner list. |
| `ownership-operations` | Private operator plane | `addOwner`, `transferOwner`, `recoverOwner` | `/ownership/add`, `/ownership/transfer`, `/ownership/recover` | `applied` or audited `refused` with the owner set, or `denied` with no effect. See [operator-assisted ownership](../lib/tenant-ownership/README.md). |
| `connector-inspection` | vcpool role | `inspectConnectors({}, signal)` | `/vcpool/inspect` | The member's pool mode, eligibility and refusal counts, the egress proxy flag, and per tenant: status (`polling`, `skipped` with the activity code, `refused`, `not-in-slice`, `member-refused`, `idle`), rows pulled, refusal counts keyed `phase:status` and the last refusal. |
| `evaluator-inspection` | evaluator role: every partitioned member; a standalone evaluator only when serve.internal is configured explicitly | `inspectEvaluator({}, signal)` | `/evaluator/inspect` | Configured pool values beside observed membership, the gate (eligible, reason, reads, refusals, heartbeats) and per configured tenant: assigned ordinal, admitted, code, cycles, output revision and delivery state. |
| `pool-operations` | Private operator plane (admin role, `pools`) | `getPool`, `setPoolMembers` | `/pool/get`, `/pool/members` | `observed` or `applied`/`unchanged` with the desired count, the count in effect, live and missing ordinals and conflicts; or `denied` with `POOL_KIND_UNKNOWN`/`POOL_MEMBERS_INVALID`. Members switch slices together once every ordinal of the new count is live. |

Service handlers must implement exactly the operations in their selected
contract. Unknown, missing or extra handler registrations fail at composition.
A request cannot select a different service on the same listener. A component with a public HTTP contract
opens a second listener/port for its internal contract; private handlers are never
mounted into its public Express router. Dispatch is an exact lookup of a fixed
`(method, path)` in the listener's route table; query strings,
encoded aliases, additional path segments and unknown paths are refused. There
is no URL forwarding, dynamic module lookup or generic proxy operation.

Every request names the selected service and protocol version in
`x-nightscout-internal-service` and `x-nightscout-internal-version`. The current
version is `1`; a missing or different service/version is refused. The wire paths
remain recognizable, but service/version enforcement requires a coordinated
upgrade of communicating processes. There is no fallback to the earlier untyped
IPC protocol. A breaking request, response or operation change requires an
explicit protocol version change and a documented deployment transition.

## Listener composition

`transport.compose(endpoint, modules)` opens one private listener for a list of
`{ service, create: token => handlers, lifetime? }` modules. Registration is
fixed before the listener binds:

- every operation contributes one `(method, path)` route; the same route twice,
  within one service or across services, fails with `INTERNAL_API_ROUTE_DUPLICATE`,
  and the same service twice with `INTERNAL_API_SERVICE_DUPLICATE`, before any
  socket or port is published;
- a request is dispatched only when its service/version headers name the owner of
  that route; a co-resident or unregistered service name is refused with the usual
  `503` and no handler runs;
- each module receives its own in-process transport token;
- `lifetime` is per module. Application modules pass `{ operationWindow,
  resolveTenant }`; the lifecycle-participant module passes none, so status and
  invalidation stay callable while a tenant is suspended and its application
  operations refuse. A listener-wide window is deliberately not offered.

`transport.open(endpoint, service, create, lifetime)` is the one-module form the
roles use today. The opened listener exposes its `routes` for inspection.
Application routing (any instance behind a service address) and per-instance
lifecycle addressing (the controller calls each participant's own endpoint) stay
distinct when they share a listener: they are different routes and services, and
the participant manifest still lists exact per-instance endpoints.

Composition changes no path, header or schema. Peers built before this change
interoperate on the wire with composed listeners. Moving a role pair onto one
listener in production needs a configuration shape that names the shared
component endpoint and a boot order that registers every module before binding;
neither exists yet.

## Clients and transport configuration

Application callers use named clients rather than passing URL paths:

```js
const { socketAuthority } = require('./lib/server/internal-api/clients');
const api = socketAuthority({
  socketPath: process.env.INTERNAL_API_SOCKET_PATH,
  maxBytes: 1048576,
  timeoutMs: 5000
});
const rights = await api.authorizeSocket({
  host: 'synthetic.example.test',
  tenant: '11111111-1111-4111-8111-111111111111',
  namespace: '/',
  credential: {}
});
```

The other factories are `alarmDelivery(options)`,
`lifecycleParticipant(options)` and `ownershipOperations(options)`. Each returns a frozen object containing only
that service's methods. Methods accept an optional `AbortSignal` as their second
argument. A new application operation belongs in its service contract, handler
implementation, named client surface, documentation and contract controls.

The shared transport interface is
`open(options, serviceContract, makeOperations, lifetime = {})`, returning
`{ close() }`, and `client(options, serviceContract)`, returning the service's
named methods. `makeOperations(transportToken)` returns an object keyed by the
contract's named methods, not URL paths. Deployment configuration must supply options from a trusted
source; request content cannot choose a socket path, URL, service or credential.

Unix-domain socket options have exactly `socketPath`, `maxBytes` and `timeoutMs`.
The socket path is absolute and bounded. Its parent directory must be owned by
the running Unix user, have no group/other access and resolve without symlink
indirection. The socket is owned by that user and has mode `0600`. Publication
refuses an existing configured endpoint. Shutdown removes only the endpoint
inode the listener actually owns. The trust boundary is the shared service UID
and protected filesystem directory; it does not distinguish individual processes
sharing that authority.

HTTP options contain `url`, `trust: 'network'`, `maxBytes` and `timeoutMs`,
with optional `bindHost` for listener composition:

```js
const api = socketAuthority({
  url: 'http://nightscout-api.internal:9081/',
  trust: 'network',
  maxBytes: 1048576,
  timeoutMs: 5000
});
```

The URL is an explicit HTTP origin with a root path and no user information,
query or fragment. DNS names, loopback, link-local and private network addresses
are supported. The listener binds to the URL hostname unless `bindHost` is
provided; clients address the URL hostname. For example, a Kubernetes listener
can bind `0.0.0.0` while clients use its Service DNS name. Select the listener
interface deliberately and enforce the intended caller set through deployment
network policy or an authenticated proxy/service mesh where required.

`trust: 'network'` explicitly acknowledges that reachability is the transport
admission boundary. HTTP does not establish process identity or implement
transport authentication or encryption. It adds no static shared-secret/bearer
protocol. Service and version headers identify the contract; they are not
credentials. Preserve network isolation for lifecycle control operations as well
as application operations. Client tenant credentials and application permission
checks remain required regardless of the transport.

For local diagnostics, use the same operation contract as the named client:

```bash
curl --fail --request POST 'http://127.0.0.1:9081/cohort/status' \
  --header 'Content-Type: application/json' \
  --header 'x-nightscout-internal-service: lifecycle-participant' \
  --header 'x-nightscout-internal-version: 1' \
  --data '{"request":"00000000-0000-4000-8000-000000000001"}'
```

That command is for an explicitly selected local lifecycle participant listener.
A socket-authority or alarm-delivery listener refuses it even when reachable.

## The internal listener (`serve.internal`)

Each multitenant role process has one private listener, `serve.internal`,
configured as `host`/`port` or `socket` (the pattern of Ory Kratos/Hydra's
`serve.public`/`serve.admin`). Every key can be overridden from the
environment:

| Key | Environment | Default |
|---|---|---|
| `socket` | `NS_SERVE_INTERNAL_SOCKET` | `<runtime>/<roles>.sock`, where `<runtime>` is `$XDG_RUNTIME_DIR/nightscout`, else `/run/nightscout`, and `<roles>` the process's roles, sorted and joined by `+` (`api.sock`, `api+realtime.sock`) |
| `host`, `port` | `NS_SERVE_INTERNAL_HOST`, `NS_SERVE_INTERNAL_PORT` | none: a network listener needs both, set explicitly |
| `shutdownTimeoutMs` | `NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS` | `5000` (at most 60000; `nightscout multitenant` requires it below its 10000 ms shutdown bound) |

`host`/`port` and `socket` are exclusive. The listener trusts its network
(`trust:'network'`) and has no authentication of its own, so the default is a
unix socket; network exposure requires an explicit host and port. When the
default socket is used its runtime directory is created with mode 0700 if it
does not exist; an existing directory must be owned by the service user with
no group or other permissions (a systemd unit needs `RuntimeDirectoryMode=0700`).

The role's code decides which contracts the listener serves
([`serve/internal-listener.js`](../lib/server/serve/internal-listener.js)):

| Role | Contracts it may serve |
|---|---|
| api | `socket-authority` (with `socketForwarding`), `lifecycle-participant` (cohort participant) |
| realtime | `alarm-delivery`, `lifecycle-participant` |
| evaluator | `lifecycle-participant` |
| tenant-admin | `lifecycle-participant` |

Configuration cannot add, move or merge a contract. A process serving several
roles serves all their contracts on its one listener. A process that serves no
contract opens no internal listener. The route table is fixed when the listener
opens, before the roles boot; a role's routes answer `SOCKET_IPC_NOT_READY`
(below) until that role has booted. Start-up refuses a role that offers a contract it
does not own and any contract left unbound.

Callers reach another role at its peer address:

| Peer | Environment | Default |
|---|---|---|
| a role this process serves | none (its own `serve.internal`) | |
| any other role | `NS_<ROLE>_INTERNAL_URL` (`http://host:port`) or `NS_<ROLE>_INTERNAL_SOCKET` | `<runtime>/<role>.sock` |

`<ROLE>` is the role name in upper case with `-` as `_` (`NS_TENANT_ADMIN_INTERNAL_URL`).
URL and socket are exclusive. A shared peer list may name the process's own
role by service name (`NS_API_INTERNAL_URL=http://api:7001` on the api
process); a peer address for an own role that names another socket, another
kind of address or another port refuses. The per-contract limits
(`maxMessageBytes`, `operationTimeoutMs`) stay on the role configurations; each
contract keeps its own bounds on the shared listener.

### Shutdown

On SIGTERM the internal listener closes first: it stops accepting connections,
closes idle ones, lets calls already dispatched finish and send their responses
for up to `shutdownTimeoutMs`, then force-closes what remains. A caller whose
call was force-closed receives `SOCKET_IPC_UNAVAILABLE` and treats the outcome
as uncertain (no retry). The role contexts stay alive while in-flight calls
drain; the public listeners and role resources close after it.

## Validation and authorization

Request and response schemas are enforced on both ends. Their transport envelopes
reject unknown fields. Credentials accept only the named credential carriers;
permissions, lifecycle status, datastore and backend identities have explicit
shapes. The bounded validator in
[`schema.js`](../lib/server/internal-api/schema.js) implements the JSON Schema
2020-12 vocabulary used by these contracts and refuses unsupported keywords.
The checked-in schemas can also be consumed by a full JSON Schema tool.

The following domain content deliberately keeps its existing wire semantics:

- Socket mutation `args` and result `replyArgs` are JSON arrays. The existing
  socket write handlers and alarm acknowledgement handler own event argument,
  collection, clinical record and callback result validation. The transport
  validates the enclosing tenant, namespace, event and credential fields and
  supported namespace/event combinations.
- Alarm `notification` is an extensible JSON object produced by
  `tenant-notifications/contract`. Provider/plugin fields remain intact. The
  existing notification producer owns its domain validation; realtime still
  checks the current tenant and each recipient's read authority.
- Alarm `receipts` is an array of provider receipt JSON. The realtime sink returns
  no provider receipt and does not claim to clear provider requests.

Structural validation does not grant authority. API handlers still resolve the
host against configured tenant aliases, compare tenant bindings, verify current
client credentials and authorize the exact write or acknowledgement. Socket
permission responses are rechecked by realtime as before. A transport-generated
in-process Symbol identifies admitted transport calls to the trusted handlers;
it is never a wire credential and does not replace client authority.

`/authorize` is the socket authority service's JSON POST operation. It is not an
nginx `auth_request` endpoint: an authorization denial can be a successful HTTP
response containing `{ "denied": true }`, and its inputs include a structured
socket namespace and credential. A reverse-proxy authorization integration would
need its own explicit request, tenant, credential and status-code contract.

## Lifetimes, failures and retries

The transport preserves the selected tenant operation window around API work and
alarm handoff, including response completion. Lifecycle invalidation can cancel
an admitted operation and destroy its response. Closing a listener stops admission,
destroys active connections and waits for outstanding handlers before cleanup.
See [the restore operation cohort](tenant-operation-cohort.md) for its complete
participant, database identity, drain and reactivation requirements.

The lifecycle participant's status is observed source-owned state. Invalidation
requires the pinned process incarnation and schema identity; acknowledgements
carry the caller's fresh request nonce and tenant. The restore coordinator still
checks those values, the participant census and actual datastore/backend
identities. A malformed response, missing peer, changed incarnation or lost
acknowledgement prevents activation and retains suspension. Schema validity does
not substitute for those semantic gates.

Request size, response size and operation duration are bounded by transport
configuration, optionally tightened per operation. Application or wire validation failures return HTTP `503` with
`{ "error": "SOCKET_IPC_UNAVAILABLE" }`, preserving the existing generic error
contract. The client rejects non-success or malformed responses with
`SOCKET_IPC_UNAVAILABLE`; local schema refusal uses `INTERNAL_API_SCHEMA_REFUSED`.
Payloads, credentials and internal exception details are not included in errors.

One case is answered distinctly: the callee is not ready. A listener that is
closing, a route whose role has not bound its handlers yet, and a handler that
refuses with `TENANT_WARMING` (the tenant is still warming in the callee) return
HTTP `503` with `{ "error": "SOCKET_IPC_NOT_READY" }`. The client still rejects
with `SOCKET_IPC_UNAVAILABLE`, and marks the error `notReady: true`; it marks a
connection that finds no listener (no socket file, refused, reset before any
answer, a name that does not resolve yet) the same way. Every other failure,
including a refused tenant, a suspended tenant, a denial and any non-200 status,
is unmarked.

The transport performs no retries. A caller may retry a `notReady` error of an
idempotent read: realtime's startup warm retries its `authorizeSocket` check
against a restarting api with bounded jittered backoff, within
`NS_TENANT_WARM_RETRY_MS` (default 60000, `0` disables) and inside the warm's
bounded concurrency (`NS_TENANT_STARTUP_CONCURRENCY`), then marks the tenant
failed as before. A timeout or disconnected response is
ambiguous: the operation may already have committed. Socket writes must not be
replayed automatically. Alarm acceptance means realtime handoff, not device
receipt; durable notification retries can repeat delivery. Restore coordination
retains its pinned identity, nonce and suspension rules rather than synthesizing
an acknowledgement after a failed request.
