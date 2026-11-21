# Tenant identity import: unsupported pending allocator maintenance review

Status: source-only research/proposal. Identity-bearing tenant import now refuses
`LIFECYCLE_IDENTITY_IMPORT_UNSUPPORTED` before INSERT, nextval, setval or DDL.
Export and deletion retain ordinals; no value is regenerated or silently omitted.
No sequence-maintenance capability, new serving privilege or workaround is adopted.
Native shared-namespace/cached-session behavior remains UNMEASURED here.

This leaves the adopted same-ID tenant restore requirement OPEN. Whole-deployment
restore into fresh namespaces is independent evidence: it can roll unrelated tenant
B back to the backup point. The shared API uses global namespace mappings; it cannot
automatically route restored A to a fresh namespace while B remains current. Do not
label either whole restore or this refusal completion of tenant restore. Operators
currently cannot use this tenant-import primitive to restore identity-bearing data.

## Mechanism and source observations

The tenant-bound NOBYPASSRLS client sees A's rows, while an identity sequence and its
counter/cache are shared across tenants. A local MAX cannot observe B or outstanding
allocations. Even globally visible MAX and a forward-only setval do not invalidate
another backend's cached numbers; stopping its client process does not close that
backend or its cache. Concurrent nextval or a retained allocator can make a later
insert precede restored order. Sequence changes also survive transaction rollback. PostgreSQL documents cache
reservation, retained-session visibility of setval and nontransactional sequence
changes in the [PostgreSQL16 CREATE SEQUENCE notes](https://www.postgresql.org/docs/16/sql-createsequence.html#SQL-CREATESEQUENCE-NOTES).
The maintenance requirements below are an engineering inference from those
semantics and this component boundary, not a measured recovery procedure.

The prior component inserted explicit ordinals with OVERRIDING SYSTEM VALUE but
issued no sequence maintenance. The source recording-client checks reproduced that
protocol, not PostgreSQL behavior. The fixture now models entries' actual identity
and removes a spurious food identity. Positive non-identity import tests explicitly
select the reviewed older entries catalogue and do not claim current tenant restore.

An optional SQL-core research helper stages a private CACHE8 sequence with two owned
operator sessions: retained session reserves1..8, operator raises the counter to100,
fresh session receives101, retained session can still receive2. It uses no app-role
privilege changes and never touches application sequences. This is a proposed bounded
native counterexample, not a recovery implementation; its native outcome has not run.
Current reviewed identity defaults remain unchanged. The prototype does not establish
that current application sequences use CACHE8.

## Recommended separately reviewed maintenance contract

Prefer a private operator maintenance job that preserves original tenant UUID,
cryptographic references, ordinals and current foreign data. Do not add sequence
UPDATE/DDL to the tenant-bound serving/import role. The following is a proposal;
no code implementing it is authorized by this document:

1. Freeze exact schema/catalogue admission, original tenant artifact and real
   identity-column/sequence association. Validate positive noncycling increment,
   supported range, default/cache/ownership and full column/ledger contract.
2. Establish a global allocation-exclusion lease for every shared namespace being
   restored. Enumerate all serving, uploader, evaluator/RT and direct SQL allocation
   paths, including tenant B. Drain writes and **close all allocator DB sessions and
   pools/caches**, observing original backend identities absent. SIGSTOP alone is
   insufficient. Prevent new allocator sessions until release; unknown allocation
   authority means refusal. The existing trusted deletion-window attestation does
   not automatically supply this stronger exclusion contract.
3. Read all-tenant row maxima, original imported ordinals and current counter under
   exact private operator authority. Resolve only known sequences; no wildcard,
   public elevated function, broad serving DDL or tenant-local approximation.
4. Import A atomically with explicit original ordinals, preserving current B rows,
   clocks/history/configuration and keys. Set each allocator strictly forward to at
   least the greater of current global counter, all-tenant live maximum and A's
   imported maximum. Recheck exclusion and counter immediately before maintenance;
   refuse exhaustion or unsupported sequence semantics. No counter rewind.
5. Treat sequence changes as nontransactional: interruption may leave safe gaps.
   Preserve exact before/after observations and keep exclusion until rows/ledger/
   artifact/foreign comparisons finish. Never rewind counters to undo a rollback.
6. Reopen only fresh reviewed allocator sessions after commit and verification.
   Test the actual canonical writer after recovery, not only a read of last_value.
   Recovery must retain A's ordering and B's present state. Document the global
   write outage and interrupted-job recovery before selecting production behavior.

An alternative schema/per-tenant allocator changes ordering semantics and consumer
compatibility, so it is not a routine implementation substitute. Renumbering or
routing A to an unreviewed fresh namespace is also not an equivalent restore.

## Compatibility and required evidence

Long-term direction: a controlled same-ID tenant restore that preserves current
foreign tenants. Architecture: separate tenant data import from privileged global
allocator maintenance/exclusion. Compatibility: preserve exact ordinal values and
existing selected namespace mappings; fail closed until this is proved. Maintenance:
one explicit operator job with bounded inputs, interruption records and exact
sequence authority. Reliability: close retained sessions, refuse unknown allocators,
prove no rewind/exhaustion and preserve foreign state. Performance: the global write
outage and scan/verification cost are UNMEASURED; no capacity or outage budget is
inferred from source tests.

Stage in the existing owned SQL-core batch: unknown current ledger refusal before
erase, identity import refusal before effects, unchanged B/counters, actual selected
entries v3 write-intent next-value property after refusal, and the optional private
cache counterexample if root includes it in the grant. A next writer after a refused
import is not a next writer after completed tenant restoration. A successful tenant
restore still needs a separately reviewed allocator contract and native proof.
No new human question is raised by this source proposal; root retains the existing
pending outage decision and any later load-bearing choice.
