# Writing to storage through `write(intent)`

Contributor guide for the write step, `lib/storage/write-intent.js`. Design: the
[write-contract spec §2](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/docs/30-design/tenancy/write-contract-spec-2026-10-07.md)
and the
[write-step design note](https://github.com/bewest/rag-nightscout-ecosystem-alignment/blob/main/docs/30-design/platform/wc-step-design-note-2026-10-27.md)
(its open questions Q-A to Q-Y are the release-2 items named below).

## The rule

**A write rule goes into `lib/storage/write-intent.js`, not into a route.** A write rule is anything
that decides what gets stored for a write: the form of `_id`, which stored record a write targets,
whether a match merges, replaces or is refused, server dates (`srvCreated`, `srvModified`), unit
conversion, validation, and removal of duplicates. Routes (API v1, API v3, the socket, in-process
callers) say what they want written and pass it to the step. They do not call the storage adapter's
write methods.

Why: when the same rule lives in each route, a fix lands on one path and misses another. BF-194's unit
conversion had to be added in four places, and WRITE_VALIDATION sat in five. The step puts each rule
in one place.

## Where the step sits

```
 routes: lib/server/{treatments,entries,devicestatus,profile,food,activity}.js (API v1, in-process)
         lib/server/websocket.js (socket)          lib/api3/generic/* (API v3)
            |
 lib/storage/write-intent.js        the intent layer: rules, one result per record
            |
 storage interface                  lib/api3/storage/mongoCollection (API v3 through
            |                       lib/api3/storage/mongoCachedCollection)
 lib/storage/write-step.js          the persistence boundary: one driver call,
            |                       one `storage-write-committed` event
 MongoDB driver
```

The step calls only the storage interface, never the driver, and emits nothing. API v3 writes through
the cached wrapper's identifier methods (`insertOne`, `replaceOne`, `updateOne`, `updateEveryForm`,
`deleteEveryForm`). API v3's identifying reads are the step's `match()`: create's (`v3-identifying`)
and PUT and PATCH `/{identifier}`'s (`v3-addressed`). When one of them picked one of several records
that share an identifier (P4), `replaceOne` and `updateOne` take that record's `_id` as one more
argument and write it by `_id`.
Each updates or removes only the record written in the in-memory cache. Do not
route a v3 write through the query methods (`replaceFiltered`, `updateMany`, `deleteMany`, `bulkUpsert`,
`insertMany`): in the cached wrapper they empty the whole cache, which the server then reloads from
MongoDB.

## How a route writes

```js
const writeIntent = require('../storage/write-intent');
const step = writeIntent.forCollection(store, 'treatments', 'v1/internal', { env: env });

const result = await step.write({ op: 'create', form: 'batch', docs: docs });
// result.items: one per document, in order: { index, outcome, _id, identifier, reason }
// outcome is one of: inserted, merged, replaced, unchanged, deleted, not-found, refused
```

- `forCollection(storage, name, source, { env })` takes the storage interface (or a function that
  returns it) and the source label: `'v1/internal'` (API v1 and in-process callers share it), `'socket'`,
  or `'v3'`. The label selects that path's rules.
- `write(intent)`: `op` is `create`, `update`, `patch` (v3), `delete` or `prune` (profile). `form` names
  a variant where an op has several, such as treatments' `batch`, `one` and `prebolus`, or v3 delete's
  `mark` and `permanent`. `docs` holds the documents; `target` holds `{ _id }` or `{ filter }` for a
  delete.
- `plan(intent)` runs a rule's synchronous part at the moment the route ran it before, so an input that
  threw still throws in the same place. `write()` accepts what `plan()` returns.
- `check(docs)` is the path's WRITE_VALIDATION rule: it returns `[{ index, problems }]` for each
  document refused (only with `WRITE_VALIDATION=reject`), and logs each one in `log` and `reject` modes.
- `identifiers(docs)` is the identifier-format rule (ID-Q6) at the moment a route can still refuse a
  document: it removes each invalid `identifier` (`WRITE_IDENTIFIER=lenient`), or, under `strict` on a path
  that refuses (`IDENTIFIER_STRICT`), returns `[{ index, problems }]` for the route to refuse. The step
  applies the same rule again right after each path's `_id` step, so a route that does not call it still
  never matches on or stores an invalid identifier.
- A storage failure inside a rule surfaces as a `WriteRuleError` naming the rule, so a route can answer
  exactly as it did when the rule was its own code.

Routes keep authorization, request parsing, reply shaping, `data-update` and `data-received` emissions,
and the socket's reply slots.

## How rules are written

`COLLECTION_RULES` has one row per collection and source, keyed by operation. A row is data, built from
named vocabularies in the same file:

| vocabulary | what it decides | examples |
|---|---|---|
| `ID_FORMS`, `DOC_ID_FORMS` | the `_id` form to write under | `stored-or-new`, `objectid-or-new`, `stored-string-or-objectid`, `treatment-uuid` |
| `TARGETS`, `DOC_TARGETS`, `DELETE_TARGETS` | which stored record a write or delete names | `id-eq`, `id-plain`, `treatment-key`, `every-form`, `id-match`, `query` |
| `onMatch`, `onExact`, `onIdentifier`, `onIdentifierMatch` | the outcome when a record matches. A matched re-send (a create) is `replaced` (compat card B and its extension, maintainer 2026-10-31): every re-send matched by identifier, on every path but API v1 and in-process entries, and every re-send 15.0.9 replaced (API v3 POST on every collection, the socket's profile dbAdd, API v1 and in-process food and activity by a stored `_id`). It is `merged` (ID-Q8, merge on match) for API v1 and in-process entries (as on 15.0.9) and for an API v1 or in-process profile re-sent by its stored `_id` (Q1b; a profile's `onIdentifierMatch` names the identifier case). Treatments are `replaced` on every path; PUT and save are `replaced`; API v3 PATCH and the socket's dbUpdate merge. A rule's `onTimeMatch` overrides it for an API v3 match on the fallback fields alone (device status: `replaced`, left to ID-NATURAL-KEY) | `merged`, `replaced`, `unchanged`, `acknowledged` (API v3: answered without a write) |
| `MERGES` (a rule's `merge`) | how a merge on match merges: JSON Merge Patch (RFC 7386, `lib/server/merge-patch.js`: a member sent replaces, an object merges member by member, an array is a value, a null removes, a member left out is kept), and which top-level members are taken whole as sent | `rfc7386`, `rfc7386-store-whole` (profile `store`, ID-Q7) |
| `twins` | removal of a record stored under the other spelling of the same `_id` | `remove-string-forms`, `remove-string-forms-after` |
| `dates` | server dates | `carry`, `stamp-created`, `stamp-modified`, `none` |
| `PREPARE`, `CHECKS` | preparation and WRITE_VALIDATION | `treatment`, `treatment-domain-v1`, `treatment-domain-socket` |
| `V3_STAMPS` | API v3's ordered stamps per operation | `units`, `dates-created`, `dates-replaced`, `subject`, `duration` |
| `write` | the storage call | `insert-one`, `replace-one`, `socket-add`, `socket-merge`, `v3-insert`, `v3-replace`, `v3-merge`, `v3-resend` (a POST that matched: merged by `updateOne`, or replaced, as the create rule's `onMatch` says) |
| `SOCKET_ADD` | the socket's dbAdd match for treatments, devicestatus and profile | exact match, then the ±2 s similar match for treatments |
| `IDENTIFIER_ALSO`, `IDENTIFIER_PICKS`, `P4_TIME_KEYS` | identifier-match: what is matched beside `identifier`, and which record a write lands on when one identifier names several | `uuid-id`, `shown-id`; `p4` (the record at the write's time key, else the newest by `_id`; ID-Q5), `every` |
| `IDENTIFIER_HELD` (a rule's `identifierHeld`) | identifier-held (ID-RULE1-EDIT): an edit by `_id` whose `identifier` another stored record holds, soft-deleted included, is refused 409 and nothing is written (`IdentifierConflictError`; the socket's refusal slot; API v3 PATCH through `identifierHeld()`) | `ignore`, `refuse` |
| `resend` (a rule's `resend: true`) | the re-send switch (ID-RESEND-SWITCH, below): marks the create rules whose matched outcome `WRITE_RESEND` and `WRITE_DELETED_RESEND` may change. Edits, the preBolus record and deletes never carry it | `true` |
| `ON_DELETED` (a rule's `deleted`) | on-deleted (ID-Q4, ID-Q3): what a write does when the record its match reaches is soft-deleted, by the kind of key that reached it (`identifier`, `identity`, API v3's `computed` identifier, `time`). A re-send on an identity is acknowledged and writes nothing; a time key does not see the deleted record, so a new one is stored; an edit is not applied (`WRITE_DELETED_EDIT=ignore\|refuse`, `DeletedRecordError` 410). API v3's computed identifier by collection (`V3_COMPUTED_IDENTIFIER`: acknowledged, except treatments, which revive in 16.0.0) | `stays-deleted`, `stays-deleted-edit`, `revive`, `hidden`, `matched` (the socket's profile, Q-R) |

### The re-send switch: `WRITE_RESEND` and `WRITE_DELETED_RESEND`

The table's `onMatch`, `onIdentifier`, `onIdentifierMatch` and `onExact` values are the outcomes under
`WRITE_RESEND=replace`, the default. With both settings unset nothing changes. On a rule marked
`resend: true`, and only for a match on an identity key (`identifier`, `_id` or another client id, API
v3's computed identifier), the step asks `resendOutcome()` instead:

| `WRITE_RESEND` | a re-send matched to a live record | item |
|---|---|---|
| `replace` | the table's outcome | as the table says |
| `merge-except-treatments` | `replaced` becomes `merged` (RFC 7386; a profile's `store` whole). Treatments always replace: a client ends an override by re-sending it without `durationType`, which only a replace removes (slice 4). The socket profile's `startDate` match merges too | `merged` |
| `acknowledge` | nothing written; the reply names the stored record | `unchanged`, reason `resend` |
| `refuse` | nothing written; API v1 and in-process answer the item's refused slot (409, `rules: [{ rule: 'resend', field }]`) in a 200 reply with a `Warning: 299` count, API v3 POST answers 409 after the same permission and immutable-field checks as the acknowledgement, the socket answers its refused slot (409). The socket's exact match (NSCLIENT_ID or a client identity) is refused; its ±2 s similar match never is | `refused`, reason `resend` |

`WRITE_RESEND` covers live matches only; a match on a soft-deleted record is governed by
`WRITE_DELETED_RESEND` alone (under `refuse` it is acknowledged and stays deleted). No mode changes a
permission check: the profile create decides the update-permission refusal (the whole-batch 401 for a
create-only client whose re-send would change a stored profile) from the table's rule, before any mode
applies.

A time key (an entry's `sysTime` + `type`, a treatment's fallback key without a client identity, device
status `created_at`, API v3's fallback fields) keeps the table's outcome under every mode: API v1 and
in-process entries matched that way merge as on 15.0.9.

`WRITE_DELETED_RESEND=revive` turns the `acknowledged` an identity re-send gets for a soft-deleted record
(`stays-deleted`) into `revive` (`deletedResendAction()`): the record is written as `WRITE_RESEND` says,
which brings it back, as one record, on every path. Under `acknowledge` or `refuse` nothing is revived. A
time key stores a new record beside the deleted one under either value.

An answer without a write (acknowledged or refused) is still a `write(intent)`: its item names the stored
record and `isNotWritten()` is true for it, so no module announces it, and `WriteResult.updated` is absent
or empty. API v3 answers such a POST in the route; the route calls the step's `settle()`, which returns
exactly `{ items, event: null, adapter: null }` (one item, `unchanged` or `refused`, `removed` and `updated`
absent) and, through `forCollectionIntent`, emits one D-EVENT with one record, also for the on-deleted
acknowledgement. Nothing in `lib/` listens to D-EVENT. `resendModeFor(env,
client)` in `lib/server/write-settings.js` is where a per-client D20 quirk will select a mode; today it
answers the site setting.

To change a rule, change the row. To add a rule the vocabulary lacks, add a named entry to the
vocabulary and use it from the row. Do not write the rule into a route.

**Release-2 variants.** Release 1 changes no behaviour. Where two paths do the same job differently
today, the table keeps both ways as data, and each variant carries a comment `// release-2: Q-x` naming
the open question that will unify it. Do not tidy a variant without that question's decision.

## Enrolling a module

1. Route the module's writes through `forCollection(...).write(...)`.
2. Add the module, or in a file that still has other writers the function, to `ENROLLED` in
   `scripts/check-write-intent.js` (gate G2). G2 then fails if the module calls a write method directly.
3. Prove nothing changed (below).

## Proving nothing changed

- `npm test`, and `node scripts/test-tiers.js check`. A new test file runs in no tier until
  `tests/tiers.json` names it.
- `node scripts/check-write-intent.js` (G2).
- The before/after suites `tests/write-intent.v1-collections.test.js`, `tests/write-intent.v3.test.js`
  and `tests/write-intent.socket.test.js` run each module as it was (frozen copies under
  `tests/fixtures/write-intent/`) and the step side by side, and require the same storage calls,
  events, emissions and replies. A frozen copy stands for the base the step is equivalent to: when `dev`
  changes a rule in a route the step has taken over, port the change into the step and update the frozen
  copy to match `dev`, marked `CHANGED`.
- `tests/websocket.dedupe-gate.test.js` pins the socket's dedupe.
- **G1, the write-contract matrix.** It is maintained in the alignment repository
  (`tools/qc/write-contract-matrix.js`) and runs every collection × path × write form against a booted
  server. Run it on your branch and on `dev`, one after the other, against the same MongoDB, and compare:

  ```sh
  WC_WORKTREE=<your worktree> WC_MONGO=mongodb://127.0.0.1:<port> \
    node tools/qc/write-contract-matrix.js --out after.json
  node tools/qc/write-contract-matrix.js --compare dev.json after.json
  ```

  It must report 0 differing cells apart from the `cache` field, which varies between runs of unchanged
  `dev`. A differing cell is a behaviour change: stop and find out why, and never edit a pinned result to
  make it pass.
- Break each rule you moved and show the matrix goes red only where you expect, or, where no matrix form
  reaches the rule, a named test. Then show that the revert matches the clean run.

## The unique index on `identifier`

`WRITE_IDENTIFIER_INDEX=try|require|off|drop` (default `try`; ID-UNIQUE-INDEX, decided 2026-10-30; `drop`
decided 2026-10-31) puts one
partial unique index, `identifier_unique`, on each collection: entries, treatments, devicestatus,
profile, food, activity and settings. It covers every record whose `identifier` is a non-empty string,
soft-deleted records included, and leaves out records whose `identifier` is absent, `null`, empty or not
a string (`partialFilterExpression: { identifier: { $type: 'string', $gt: '' } }`). The build and the
duplicate count run at boot, in `lib/storage/identifier-index.js`:

- `try`: the index is built online on each collection where no stored records share an identifier.
  Where some do, the server logs, per collection, how many identifiers are shared and by how many
  records (never the values), shows the same counts under `identifierIndex` in `/api/v1/status.json`,
  raises an admin notification, and runs without the index there. Records whose stored `identifier` is
  not a string (null, a number, an array: written before identifier-format treated such a value as absent)
  are counted on their own line and under `nonStringIdentifiers`.
- `require`: as `try`, but a collection without the index stops the boot.
- `off`: nothing is built and nothing is dropped. An index already there is left as it is and is still
  enforced; the server logs, per collection, `identifier index on <name>: present and enforced: ...`, and
  `/api/v1/status.json` shows that collection as `present` with `enforced: true` and the same note. One
  admin notification, "The unique index on identifier is still enforced", names every such collection.
- `drop`: at boot, the index is removed from each collection that has it, with one log line per
  collection (`identifier index on <name>: dropped identifier_unique from collection <stored name> ...`)
  and one info line naming the collections that had none (`... nothing to drop`). The server then runs as
  `off`, without the index. API v3's own non-unique `identifier_1` is a different index and is left
  alone. A later start under `try` builds the index again.

With the index on, a duplicate key on it means two uploads of one record raced: both ran the identifier
match before either was stored. The step's `DUPLICATE_IDENTIFIER` entry applies the second upload once
more as its path applies a re-send (API v3 create: the identifying read again, then the deduplicating
replace, or the device status acknowledgement, answered 200 with `isDeduplication` as a re-sent POST
is), and a second failure is thrown. Only creates are
retried; an edit whose identifier another record holds is a conflict, not a re-send. Without the index
the error cannot arise, so the entry does nothing.

**Operator steps.**

- Report the records that block the index:
  `node tools/identifier-duplicates.js report [--collections treatments,entries] [--show-identifiers]`.
  It connects as the server does (`MONGODB_URI` and the `MONGO_*_COLLECTION` settings).
- Resolve them: `node tools/identifier-duplicates.js resolve` prints what it would do;
  `resolve --apply` does it. Stop the server and take a backup first. It first unsets each stored
  identifier that is not a string (its value kept in `identifierReleased`). In each group the record P4
  picks (`p4Pick`; with no write to compare, the newest by `_id`) among the live holders (`isValid` not
  false), or among all of them when none is live, keeps the identifier. A twin of it
  (the same `_id` stored as an ObjectId and as its string) is removed. Every other record is kept, with
  its identifier moved to `identifierReleased` and a new `srvModified`. Then start the server: under
  `try` it builds the index.
- Remove the index, for example before reverting this change or to go back to running without it:
  start once with `WRITE_IDENTIFIER_INDEX=drop` and check the log lines, then keep `drop` or set `off`.
  Where that is not possible (a version without the setting is already running), drop it in the MongoDB
  shell, once per collection:
  `db.treatments.dropIndex('identifier_unique')` (and `entries`, `devicestatus`, `profile`, `food`,
  `activity`, `settings`, under their configured names). A version without the index does not need it
  dropped to run, but it then refuses a second record with a stored identifier on every path,
  including the ones that do not match on identifier yet.

## What the step does not do

- It does not emit or change `storage-write-committed`. That event belongs to the persistence boundary
  (`lib/storage/write-step.js`).
- It does not call the driver.
- It does not authorize, parse requests or shape replies.
