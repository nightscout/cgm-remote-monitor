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
| `onMatch`, `onExact`, `onIdentifierMatch` | the outcome when a record matches. A matched re-send (a create) is `replaced` on API v3 POST (every collection), the socket's profile dbAdd, and an API v1 or in-process food or activity create by a stored `_id`, as on 15.0.9 (compat card B, maintainer 2026-10-31; slice 4's ID-Q8 had them `merged`). It is `merged` (ID-Q8, merge on match) where card B left the merge: API v1 and in-process entries, device status and profile creates, and a create that identifier first sent to a stored record (a rule's `onIdentifierMatch`; the socket's entries, food and activity dbAdd, and v1 / in-process food and activity). Treatments are `replaced` on every path; PUT and save are `replaced`; API v3 PATCH and the socket's dbUpdate merge. A rule's `onTimeMatch` overrides it for an API v3 match on the fallback fields alone (device status: `replaced`, left to ID-NATURAL-KEY) | `merged`, `replaced`, `unchanged`, `acknowledged` (API v3: answered without a write) |
| `MERGES` (a rule's `merge`) | how a merge on match merges: JSON Merge Patch (RFC 7386, `lib/server/merge-patch.js`: a member sent replaces, an object merges member by member, an array is a value, a null removes, a member left out is kept), and which top-level members are taken whole as sent | `rfc7386`, `rfc7386-store-whole` (profile `store`, ID-Q7) |
| `twins` | removal of a record stored under the other spelling of the same `_id` | `remove-string-forms`, `remove-string-forms-after` |
| `dates` | server dates | `carry`, `stamp-created`, `stamp-modified`, `none` |
| `PREPARE`, `CHECKS` | preparation and WRITE_VALIDATION | `treatment`, `treatment-domain-v1`, `treatment-domain-socket` |
| `V3_STAMPS` | API v3's ordered stamps per operation | `units`, `dates-created`, `dates-replaced`, `subject`, `duration` |
| `write` | the storage call | `insert-one`, `replace-one`, `socket-add`, `socket-merge`, `v3-insert`, `v3-replace`, `v3-merge`, `v3-resend` (a POST that matched: merged by `updateOne`, or replaced, as the create rule's `onMatch` says) |
| `SOCKET_ADD` | the socket's dbAdd match for treatments, devicestatus and profile | exact match, then the ±2 s similar match for treatments |
| `IDENTIFIER_ALSO`, `IDENTIFIER_PICKS`, `P4_TIME_KEYS` | identifier-match: what is matched beside `identifier`, and which record a write lands on when one identifier names several | `uuid-id`, `shown-id`; `p4` (the record at the write's time key, else the newest by `_id`; ID-Q5), `every` |
| `IDENTIFIER_HELD` (a rule's `identifierHeld`) | identifier-held (ID-RULE1-EDIT): an edit by `_id` whose `identifier` another stored record holds, soft-deleted included, is refused 409 and nothing is written (`IdentifierConflictError`; the socket's refusal slot; API v3 PATCH through `identifierHeld()`) | `ignore`, `refuse` |
| `ON_DELETED` (a rule's `deleted`) | on-deleted (ID-Q4, ID-Q3): what a write does when the record its match reaches is soft-deleted, by the kind of key that reached it (`identifier`, `identity`, API v3's `computed` identifier, `time`). A re-send on an identity is acknowledged and writes nothing; a time key does not see the deleted record, so a new one is stored; an edit is not applied (`WRITE_DELETED_EDIT=ignore\|refuse`, `DeletedRecordError` 410). API v3's computed identifier by collection (`V3_COMPUTED_IDENTIFIER`: acknowledged, except treatments, which revive in 16.0.0) | `stays-deleted`, `stays-deleted-edit`, `revive`, `hidden`, `matched` (the socket's profile, Q-R) |

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

## What the step does not do

- It does not emit or change `storage-write-committed`. That event belongs to the persistence boundary
  (`lib/storage/write-step.js`).
- It does not call the driver.
- It does not authorize, parse requests or shape replies.
