# Tenant-local insertion primitive: explicit SQL proposal

Dormant standalone operator proposal; no current catalogue or default is changed.
`require('./tenant-insertion-sql').build({namespace,domain})` returns SQL statements
in `up`, plus `servingGrants(role)` and `restoreGrants(role)` statements. Only
entries,food,treatments,devicestatus,profile are recognized. Each uses its existing
separate physical domain namespace; applying two conversions in one namespace
refuses on the counter/function names rather than silently sharing a counter.

## Explicit conversion prerequisite

The caller must execute the entire `up` list in ONE transaction against the exact
reviewed existing ordinal-bearing schema. The first statement acquires the normal
ACCESS EXCLUSIVE migration table lock; this is a schema-conversion DDL lock, not a
shared allocator maintenance pause during later tenant restoration. No committed
row ordinal is renumbered. Positive unique per-tenant source ordinals are validated;
per-tenant maxima seed a new tenant_insertion_ordinal table. The original IDENTITY
is removed, which removes its internally-owned global sequence. Actual sequence
absence must be verified in the native proof.

`SET LOCAL row_security=off` makes a migrator without all-row visibility refuse
rather than silently seed one tenant. Only the already-private DDL/all-row migration
operator can perform this conversion; runtime roles receive no all-row authority.
The new counter table ends with enabled FORCE RLS and tenant policy. DDL/schema,
identity source, inheritance and source ordinal refusal checks must remain within
the same transaction, so interruption rolls conversion back.

**Current MIG-RUNNER integration is unsupported:** validateCatalogue accepts only
CREATE/ALTER/DROP/INSERT/UPDATE/DELETE/GRANT/REVOKE/COMMENT statement prefixes;
this standalone list deliberately exposes LOCK,SET and DO instead of hiding them
inside executable functions or changing its validator. An append-only reviewed
catalogue/runner integration must be designed separately. Existing immutable
catalogue bytes/checksums stay untouched.

## Runtime primitive and trust

A SECURITY INVOKER BEFORE INSERT/UPDATE trigger checks current tenant binding and
uses only qualified counter/source relations with pg_catalog search_path. Ordinary
INSERT omitting the internal ordinal atomically advances only that tenant's row.
Different tenants have different row locks; there is no database sequence or global
allocator lock. Existing clinical/history timestamps and writeClock are independent.
The trigger does not depend on the optional writeClock decorator, so admitted raw
and lower-port inserts share the primitive.

Explicit operator restore INSERT preserves its original ordinal and advances only
its own floor using GREATEST. It cannot rewind B or require reading B's maximum.
UPDATE cannot change tenant_id or insertion_ordinal; doc/id_kind updates do not
consume ordinal values. The unique per-tenant ordinal index refuses ambiguous
insertion-order ties. An exhausted ordinary counter refuses with SQLSTATE22003;
transaction rollback discards the ordinal change. No gapless or cross-tenant ordering
contract is introduced.

If a tenant has existing rows but its counter is missing, INSERT refuses; it never
silently recreates the floor at1. A genuinely empty new tenant can initialize
atomically. Missing-counter and floor-readiness recovery are not permissions for
ordinary serving to reset counters. Counters become part of lifecycle capture and
restoration; restore ordering and safe reconciliation need explicit integration.

The grant helpers revoke direct table/ordinal INSERT for each named role before
granting ordinary INSERT(tenant_id,id_kind,doc), or operator INSERT including ordinal.
Runtime counter rights are SELECT,INSERT(tenant_id,last_ordinal),UPDATE(last_ordinal).
Inherited table/column INSERT, PUBLIC privileges and role memberships must be
independently reviewed: revoking a direct grant does not cancel inherited grants.
Do not claim normal ACL enforcement until actual role tests pass. Function PUBLIC
execute is revoked; named roles get explicit execute.

The trust model matches existing tenant write-clock authority, not Byzantine database
protection. A compromised runtime with direct SQL counter UPDATE can damage its own
floor; RLS restricts that identity's tenant access. A malicious DBA/bypass role can
still alter shared storage. This proposal does not certify protection from them.
A stalled A transaction can hold A's row lock; shared pool limits, lock/statement
timeouts and consistent clock-before-domain counter ordering still need operational
acceptance. Multi-domain maintenance should acquire counters in a declared fixed
domain order. A tenant-local primitive does not isolate the shared database/pool.

## Integration boundary

New counter relations, trigger/function definitions and privileges must be added to
schema/readiness, ACL checks, immutable migration successors and full lifecycle/
backup inventory. The old exact relation inventory correctly refuses these unadmitted
relations. DROP IDENTITY changes physical column metadata: the old import identity
refusal alone is not the new-schema admission rule. Full restore still requires A
exclusion, authoritative actor checks, checkpoint/cache/history reconciliation and
verification before serving resumes. None is enabled by this standalone generator.

Source tests validate interpolation boundaries, role grant distinction and the
explicit current-runner mismatch. Native migration, RLS/ACL, concurrency, rollback,
restore and client-observable first-match acceptance belong to the coordinator's
owned proof on the exact frozen source. No full-programme readiness is claimed.
