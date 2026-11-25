# Explicit socket profile order repair — native restoration pending

Reproduced on root e863: canonical Mongo first empty profile add stored1 and
returned document; canonical PG source profile add stored0 and reply[[]], with
unsupported bounded unsorted lookup. Exactretry/multiplefirstmatch were not run.
Root independently verified raw observations and cleanup. Read-derived mechanism:
write-intent profile exact-match reads a FULL first record by NSCLIENT_ID/startDate
before insert/merge; it cannot be recast as a boolean existence projection. The
base PG reader correctly refuses bounded nonunique unsorted reads.

The repair reuses the reviewed treatment/devicestatus persisted insertion-order
mechanism ONLY for explicit profile socket selection, through the actual profile
factory and canonical executor. No sorted_id/date substitute, Mongo fallback,
new client packet, single/default change or automatic migration. The new optional
postgres-profile-socket-order-v1 catalogue contains EXACT unchanged reviewed0001
and appended0002. Upgrade obtains existing migration transaction/DDL locks,
requires physically empty table with validated CHECKfalse, removes guard, adds
GENERATED ALWAYS IDENTITY insertion_ordinal and tenant/ordinal index. A populated
table refuses atomically, preserving data/columns/ledger. No truthful original
natural order can be inferred from ctid/IDs/date after the fact; no importer or
historical-order backfill is invented. Operators need an independently reviewed
order-provenance migration before populated admission can change.

Fresh insertion-order is the bounded hypothesis matched to the actual unindexed
Mongo reference. It is not an assertion about every historic Mongo storage/index
plan or record relocation. Native restoration must run the SAME three cases and
record raw replies/physical order BEFORE assertions; source protocol pass alone
is not native/backend completion.

## Exact consumer admission matrix

|Consumer|Base namespace|Successor namespace|
|---|---|---|
|Old/default BASE catalogue binary|admits BASE|MIG_UNKNOWN, intentional rollback boundary|
|New API, socketForwarding omitted|BASE unchanged|MIG_UNKNOWN, no implicit selection|
|New API, socketForwarding selected|MIG_STALE before listener|selected full-domain readiness admits successor; REST/profile-editor ports retain their existing explicit sorts; socket port uses ordinal|
|New RT/evaluator, socketOrderDomains omitted|BASE unchanged|MIG_UNKNOWN|
|New RT/evaluator, socketOrderDomains includes profile|MIG_STALE|explicit selected readiness admits successor; clinical/current projection SQL is unchanged|
|Operator migrate CLI|explicit BASE catalogue|explicit successor catalogue required; never boot DDL|
|Owner/tenant-admin role|no clinical profile table consumed|not a profile consumer; auth/settings catalogue policy unchanged|

Same explicit reader selection applies reviewed treatments/devicestatus successors
in the same shared namespaces. Consumer owner adds optional unique
socketOrderDomains subset T/D/profile to common evaluator config and infrastructure
identity; this lane consumes it in readiness and RT parser forwarding. Merge both
before final full-role acceptance. It is metadata admission, not a query-order
change to ordinary REST readers or automatic migration.

## C census and least privilege

New file migrations/candidates/postgres-profile-socket-order-v1.json; preserve
postgres-profile-v1.json byte-identical. Adds profile.insertion_ordinal bigint,
sequence profile_insertion_ordinal_seq, index profile_tenant_insertion
(tenant_id,insertion_ordinal); NO new clinical table or tenant/user policy.
API actual profile writer needs USAGE on this exact sequence for DEFAULT nextval;
no sequence UPDATE/SELECT grant needed, no role ownership/BYPASS/DDL. Existing
clinical CRUD, forced RLS, metadata ledger SELECT stay as reviewed. RT/evaluator
stay read-only clinical + owned checkpoint bookkeeping, no sequenceUSAGE/write.
API whole-domain readiness selection includes profile (also REST/editor startup),
actual socket constructor checks optional catalogue through readiness identity.

## Root restoration and controls

Existing early CLI profile-port-differential config adds
`profileOrderCatalogue:"socket-order-v1"`; root bootstrap selects the successor
on an EMPTY owned table and grants exact writer sequenceUSAGE. Full privateAPI
phase uses socketForwarding and shared selected readers, not this fixture knob.
Run unchanged empty/addretry/preseed-b-then-a cases. Remove naturalOrder wiring:
empty add must restore original unsupported-sort/storage0 failure. Replace ordinal
sort with _id sort: multiple-match must choose wrong stored ID/record and turn
reply+physical oracle red, not just change a SQL string. Reader/API catalogue
selection ablation must refuse successor startup. All require fresh grant.

Optional profile-catalogue-upgrade CLI phase consumes root-owned empty/populated
base schemas named config.upgradeNamespaces matching ownership; records original
rows/ledger/columns/guard, then requires populated atomic refusal, empty success,
oldBASE refusal and ordinal retention through UPDATE. It creates no containers,
roles or schema lifecycle. Root owns exact cleanup and native source controls.
None of the new repair/upgrade phases has run in this lane.
