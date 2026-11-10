# Internal service APIs

The optional multitenant server roles use explicit internal APIs for socket
credential decisions, socket writes, notification handoff and tenant restore
coordination. Each listener owns one named service. A shared transport carries
JSON requests and responses over a Unix-domain socket or an internal HTTP
connection with explicit network trust configuration.

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

| Service | Listener owner | Named client method | POST path | Result |
|---|---|---|---|---|
| `socket-authority` | API role | `authorizeSocket(body, signal)` | `/authorize` | Current permissions and readable collections, optionally display settings; `{ "denied": true }` for a credential denial. |
| `socket-authority` | API role | `executeSocketMutation(body, signal)` | `/mutate` | Canonical socket handler callback arguments in `replyArgs`. |
| `alarm-delivery` | Realtime role | `deliverAlarm(body, signal)` | `/alarm` | `{ "accepted": true, "receipt": null, "clearedRequestIds": [] }` after realtime fanout handoff. |
| `lifecycle-participant` | Each configured serving participant | `getStatus(body, signal)` | `/cohort/status` | Participant roles, tenant set, process incarnation, schema identity, observed datastore and database backend identities. |
| `lifecycle-participant` | Each configured serving participant | `invalidateTenant(body, signal)` | `/cohort/invalidate` | Status plus the invalidated tenant, after actual role invalidators finish. |
| `ownership-operations` | Private operator plane | `listOwners(body, signal)` | `/ownership/list` | Current owners, or `denied` without an owner list. |
| `ownership-operations` | Private operator plane | `addOwner`, `transferOwner`, `recoverOwner` | `/ownership/add`, `/ownership/transfer`, `/ownership/recover` | `applied` or audited `refused` with the owner set, or `denied` with no effect. See [operator-assisted ownership](../lib/tenant-ownership/README.md). |

Service handlers must implement exactly the operations in their selected
contract. Unknown, missing or extra handler registrations fail at composition.
A request cannot select a different service on the same listener. An internal
contract uses its own server and endpoint. A component with a public HTTP contract
opens a second listener/port for its internal contract; private handlers are never
mounted into its public Express router. Dispatch is an exact lookup of a fixed
path in the selected service's table; query strings,
encoded aliases, additional path segments and unknown paths are refused. There
is no URL forwarding, dynamic module lookup or generic proxy operation.

Every request names the selected service and protocol version in
`x-nightscout-internal-service` and `x-nightscout-internal-version`. The current
version is `1`; a missing or different service/version is refused. The wire paths
remain recognizable, but service/version enforcement requires a coordinated
upgrade of communicating processes. There is no fallback to the earlier untyped
IPC protocol. A breaking request, response or operation change requires an
explicit protocol version change and a documented deployment transition.

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

## Deployment endpoint descriptors

Environment-reference configuration keeps endpoint addresses outside the checked-in
configuration document. An endpoint descriptor selects exactly one transport:

```json
{ "socketPathEnv": "NS_INTERNAL_API_SOCKET" }
```

```json
{
  "urlEnv": "NS_INTERNAL_API_URL",
  "trust": "network",
  "bindHostEnv": "NS_INTERNAL_API_BIND_HOST"
}
```

`bindHostEnv` is optional. For Kubernetes, `NS_INTERNAL_API_URL` can be
`http://nightscout-api.internal:9081/` and `NS_INTERNAL_API_BIND_HOST` can be
`0.0.0.0`. A deployment can instead select an explicit link-local address such as
`http://169.254.1.1:9081/`, provided that address is assigned/routed appropriately.
These are endpoint examples; the deployment still owns listener placement and
access policy. An HTTP port for an internal service must differ from the same
component's public listener port.

The existing limits stay on the containing configuration. Supply exactly one of
the legacy socket-path field and its endpoint-descriptor alternative:

| Configuration | Existing Unix socket reference | Transport-neutral alternative |
|---|---|---|
| API `socketForwarding` | `socketPathEnv` | `endpoint` |
| Realtime API client | `apiSocketPathEnv` | `apiEndpoint` |
| Realtime alarm listener | `alarmSocketPathEnv` | `alarmEndpoint` |
| Evaluator consumer `route` | `socketPathEnv` | `endpoint` |
| Lifecycle participant | `socketPathEnv` | `endpoint` |

The caller and listener must select the same service endpoint and limits compatible
with its messages. Each lifecycle participant retains a distinct endpoint. Using
HTTP changes transport admission to deployment-owned network trust; it does not
change client authorization, tenant admission or restore coordination rules.

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
configuration. Application or wire validation failures return HTTP `503` with
`{ "error": "SOCKET_IPC_UNAVAILABLE" }`, preserving the existing generic error
contract. The client rejects non-success or malformed responses with
`SOCKET_IPC_UNAVAILABLE`; local schema refusal uses `INTERNAL_API_SCHEMA_REFUSED`.
Payloads, credentials and internal exception details are not included in errors.

The transport performs no retries. A timeout or disconnected response is
ambiguous: the operation may already have committed. Socket writes must not be
replayed automatically. Alarm acceptance means realtime handoff, not device
receipt; durable notification retries can repeat delivery. Restore coordination
retains its pinned identity, nonce and suspension rules rather than synthesizing
an acknowledgement after a failed request.
