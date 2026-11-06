# Storage port contract

The port is the injected object and its capabilities. Callers must select it
explicitly. The shared write rules in `write-intent.js` supply domain behavior;
an adapter does not authorize a request or select a backend for a caller.

`tests/storage-port-contract.integration.test.js` characterizes the admitted
intersection against real MongoDB and PostgreSQL, and pins deliberate capability
differences. Run it with:

```sh
NS_STORAGE_PORT_CONTRACT_DOCKER_TEST=1 node node_modules/mocha/bin/mocha.js \
  tests/storage-port-contract.integration.test.js
```

The test owns disposable loopback Docker services, a database whose name contains
`test`, and a PostgreSQL role with neither superuser nor RLS bypass. It removes its
services and database. Without the opt-in it registers pending tests and opens no
services. No external connection settings are consumed.

## Current objects

| Object | Surface and caller responsibility |
| --- | --- |
| `api3/storage/mongoCollection` | `findOne`, `findEveryForm`, `findOneFilter`, `findMany`, `findFiltered`, `count`, `getLastModified`; insert/replace/update/delete, every-form, resolution, filtered and batch methods. Driver handles stay private. `version` is backend instrumentation. |
| `postgres-entries-read` | `findOne`, `findMany`, `findFiltered`, `findNatural`, `count`. Strict AST/JSON subset; schema and tenant connection are supplied. |
| `postgres-entries-write` | `insertOne`, `insertMany`, `replaceOne`, `replaceFiltered`, `updateOne`, `updateMany`, `updateEveryForm`, `deleteOne`, `deleteMany`, `deleteEveryForm`, `deleteManyOr`, `bulkUpsert`, `resolveOne`, `resolveEveryForm`, `resolveOr`, `findByIds`, document/patch validators. Persistence and result translation, without intent events. |
| `postgres-entries-intent` | Shared v3 intent boundary with `storage`, `match`, `write`, `settle`, and shared intent helpers. It requires ownership of a fresh transaction. |
| `postgres-collection-intent` | Trusted logical collection and source composition over the same reader/writer. Adds bounded translation of shipping Mongo-shaped predicates, top-level projections and optional natural-order reads. It requires ownership of a fresh transaction. |

The parameterized corpus covers MongoCollection, the lower PostgreSQL reader and
writer, and the entries v3 `postgres-collection-intent.storage` object. Intent
event tests cover MongoCollection plus both PostgreSQL intent wrappers, including
the general wrapper with its legacy source. Other logical
collections and HTTP rendering keep their own integration tests.

## Identity and document representation

Stored identity retains its kind. An ObjectId and a same-spelling string are two
records. PostgreSQL keeps `id_kind` outside the JSON document and restores the
ObjectId on read; clients do not receive that storage metadata. A normalized
read removes `_id` and supplies its string form only when `identifier` is falsy.
Absent, null, false and zero identifiers stay distinct in the stored document.
An identifying read prefers an explicit identifier, then ObjectId, then string
fallback. The corresponding single-record writes select the same record.

The admitted PostgreSQL document is JSON-safe with a nonempty string or ObjectId
`_id`; an omitted `_id` can be generated on insert. Nested Date, BSON values,
undefined, nonfinite numbers, negative zero and other lossy shapes are refused
rather than serialized away. MongoDB admits broader BSON representations.
MongoDB's driver generates an ObjectId for submitted `_id: null`; PostgreSQL
refuses that submitted identity. MongoDB stores boolean and numeric `_id` values,
which the PostgreSQL identity codec refuses. These differences are capabilities,
not permission to coerce one stored kind into another.

## Queries, projection and ordering

`filter.js` defines the strict AST: `and`/`or` groups and named comparisons.
An unknown operation is refused. Null equality and null `lte` match absent and
explicit null values; `exists` distinguishes them. Zero, false and string zero
remain different operands. Null `gt` matches neither absent nor null.

| Shape | Lower PostgreSQL reader | PostgreSQL intent storage | MongoCollection |
| --- | --- | --- | --- |
| Scalar comparisons, type-bracketed ordering, explicit scalar sort/pagination | Supported subset | Same underlying subset | Supported |
| Inclusion projection with integer `1`, retaining `_id` | Top-level and dotted inclusion | Top-level only | Supported |
| Top-level exclusion or `_id: 0` inclusion | Refused | Supported by intent projection helper | Supported |
| Bounded read without explicit sort | Refused | Only explicit trusted identifying/existence/natural-order paths | Uses Mongo storage order |
| Dotted query paths; general regex | Refused by default | Bounded source-specific translation only | Broader Mongo semantics |
| v1 dialect; driver read options | Refused | Narrow translation for admitted shipping callers | Supported shipping dialect |

`findMany` uses API v3 filter definitions, distinct from `findFiltered`'s AST.
The lower PostgreSQL port requires explicit integer limit/skip and sort; MongoDB
retains legacy argument parsing. There is no promise of arbitrary Mongo query or
aggregation emulation. A PostgreSQL sort over arrays/subdocuments is refused.

Natural order is a separate capability. PostgreSQL `findNatural` requires
`naturalOrder: true` and schema/import support for `insertion_ordinal`. A schema
without it does not acquire an equivalent order from `_id` or generated columns.
This corpus asserts refusal when the capability is disabled; import-order
preservation is outside its fixture.

## Results, batches and failures

Persistence results describe the actual operation: `updateOne` returns
`{ updated }`, `deleteOne` returns `{ deleted }`, and `deleteMany` additionally
returns `acknowledged` and `deletedCount`. Setting null differs from removing a
field. An unchanged update reports zero changes; a missing target stays missing.

Ordered duplicate-key batches retain their successful prefix; unordered batches
continue after the failing item. Error indices and result counts describe the
successful operations, and a recovered PostgreSQL savepoint leaves the outer
transaction usable. The corpus checks both replies and stored records. It does
not promise that every invalid document can be partially accepted: PostgreSQL
validates representation before a batch begins.

Unsupported read shapes carry `UnsupportedQueryError`/`unsupported: true`;
write representation refusals use TypeError, with the write-specific unsupported
marker where defined. Duplicate `_id` outcomes map to code `11000`. Unrelated
SQL/internal and unavailable-connection failures retain their backend failure;
they do not become unsupported input. HTTP status/reply differences belong to
the shipping v1/v3 handlers and their tests.

## Tenant binding, transactions and events

Tenant binding and transaction ownership are separate capabilities. MongoCollection
asserts a bound scope in multitenant mode. It does not filter a shared collection
by tenant, open a transaction, or roll back completed writes on caller failure.
Its fixture selects an explicit collection; changing the scope does not remap
that handle. A multitenant composition must supply its own supported isolation.

PostgreSQL obtains the current UUID binding when the operation runs. Adapters
do not capture a tenant when constructed. Its connection binds RLS inside a
transaction, reuses a nested scope only for the same tenant, and refuses a
cross-tenant rebind. A raw application-role read without binding returns no rows.
An owned transaction rolls back on failure. A write-intent commit boundary
refuses an existing transaction rather than claiming an outer commit it does
not own.

The logical `storage-intent-committed` event describes one resolved intent,
including no-op outcomes. Backend write instrumentation is a different event.
Mutating PostgreSQL `write` events follow the owned commit and do not occur
after a failed commit boundary. A resolved no-op `settle` can emit without a
database mutation/commit; the logical event is not proof of a physical write.
Resolved deletes preserve typed stored forms in event records.
The event carries `tenant` (the bound tenant id, or null under single tenancy)
and `stamp` (the final tenant write clock floor of the transaction that
committed the write, handed to the queued publication after COMMIT; null for
`settle`, for a transaction that allocated nothing, and on every backend
without the clock).
The existing event helper also collapses unnamed or over-cap record lists; this
bounded corpus does not measure that branch, durable delivery, restart recovery,
or retry ambiguity after a lost reply. MongoDB standalone operations do not
provide PostgreSQL's multi-operation rollback guarantee.


## Shared PostgreSQL intent mechanics

`postgres-intent-common.js` contains the identical top-level projection,
identifying-read ordering/limit/normalization and owned-commit event wrapper used
by both PostgreSQL intent adapters. Each adapter retains its existing error label,
source-specific filter translation and admission rules. Lower-reader nested
inclusion projections remain separate from preview top-level projections; legacy
natural-order reads remain explicitly owned by the general collection adapter.

The common wrapper emits only after an owned transaction returns successfully.
A failed mutating transaction publishes nothing. Synchronous settle emits a
no-write logical outcome without opening a transaction. Observer failures retain
the shared write-intent emitter's behavior; they cannot roll back a committed
write or convert settle to an asynchronous operation. These local events do not
establish durable delivery or recovery.
