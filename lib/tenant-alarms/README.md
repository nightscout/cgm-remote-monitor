# Durable tenant-wide alarm suppression

Explicit multitenant composition for the adopted tenant-wide acknowledgement/snooze
contract. Nothing imports it from the default single-tenant server. It starts no
listener, timer, provider or migration. Original expiry is durable, repeats during
an active window do not slide it, and a newly accepted level-2 ack also acks level 1.
An already-active lower-level window retains its own original expiry. The default
duration remains 30 minutes. A repeat of an already-active level-2 ack returns
before lower-level recursion, matching the single-tenant notification code.

`composition.createReceiver` supplies the existing D23 receiver's actual
`persistAlarmAck` implementation. The trusted host must explicitly supply transport
admission, independent tenant resolution, current socket-credential authorization,
transaction-bound authorization and the existing DATA write executor. The original
socket credential is passed again to transaction admission; an admitted workload
identity or cached actor is insufficient. The returned receiver resolves its empty
acknowledgement vector only after the PostgreSQL connection confirms COMMIT.
Failed or ambiguous operations throw; the existing forwarder sends no acknowledgement.
The existing `/alarm` client usually supplies no acknowledgement callback; this
component does not change that protocol or synthesize a new reply payload.

The transaction-bound callback receives `{connection, tenant, credential, actor,
namespace, event, args}` and must query current authority with that connection at
operation admission. The callback decides authority only; it must not send or commit.
The API mutation uses the socket source, but writes a separate suppression table;
it does not stamp or modify clinical collections, clinical consumer checkpoints or
plugin configuration. This prototype supplies no deployment authenticator or
production socket-credential adapter. Mounting the private API receiver and the
realtime transport remains an explicit integration step.

`postgres.createReader` uses a SELECT-only role and explicit row/byte bounds.
`allows({tenant,notification,at})` re-reads durable suppression for every attempt;
errors propagate. This is the retry-time gate for a durable notification outbox,
which must separately recheck its request's current configuration/allowlist.
Information, announcements and clear messages retain their existing exemption.
Persisted suppression is independent of clinical checkpoint/configuration identity.
There is no provider-send or external exactly-once claim.

`composition.createCycle` consumes the lifecycle owner's trusted interface:

```js
const selected = createCycle({ connection: suppressionReaderConnection, namespace,
  maxRows, maxBytes,
  current: tenant => evaluatorRuntime.last(tenant),
  isCurrent: (tenant, identity) => evaluatorRuntime.isCurrent(tenant, identity) });
const output = await selected.select(tenant);
```

`last` supplies `{identity,runtimeId,outputRevision,inputCheckpoint,trigger,result,
eligible}`. Only successful eligible output is accepted. The gate rechecks the
current config/allowlist and exact output identity after reading suppression.
The returned envelope preserves metadata and properties, replacing only
`result.emitted` with eligible notifications. No fallback is returned on failure,
config change or close; the caller's clinical result is untouched. Local output
revision and input checkpoint are not a durable notification request identity.
Plugin-generated `requestSnooze` already affects that cycle's emitted output; it
is not silently converted into an authorized durable human ack.

Legacy boundary characterization is deliberate: active-repeat refusal uses
`now < expiry`, while emission requires `cycle.now > expiry`. Consequently an
ack can open a new window exactly at expiry, while an unsuperseded old window
still suppresses an emission at that same millisecond. Tests preserve both.
Numeric times/durations must be finite, safe, representable millisecond integers;
omitted, null or zero duration selects the existing default. Negative durations,
numeric strings and other malformed coercions are refused explicitly. Group names
are nonempty, control-free UTF-8 strings up to the table's explicit 512-byte bound;
this does not claim compatibility with every malformed legacy coercion.

Operator provisioning applies the new isolated candidate catalogue to an explicit
non-system namespace. No existing migration is rewritten. The API role needs
schema USAGE and table SELECT, INSERT, UPDATE(acked_at,expires_at); the evaluator
needs schema USAGE and table SELECT; realtime needs neither. Every operation
checks forced RLS/nonownership and refuses broad table/key/schema write authority.
Neither serving role owns schema or table or has BYPASSRLS. This component does
not grant clinical/credential/schema/operator writes or apply migrations.

Focused source tests cover receiver/forwarder composition, real evaluator plugin
output, current authority, expiry and emission boundaries, metadata and failure
fences. Native execution remains a separately reviewed opt-in:
`NS_TENANT_ALARM_TEST=1` with externally supplied `NS_TEST_POSTGRES_ADMIN_URI` for a
disposable test database. The fixture starts no container or listener. Capacity,
historical row retention, transport deployment, live roles, the complete M5 gate
and production activation remain separate acceptance work.
