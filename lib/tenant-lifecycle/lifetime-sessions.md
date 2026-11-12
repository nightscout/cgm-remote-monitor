# Bounded worker lifetime sessions

The optional `leaseSessions` integer in `MULTITENANT_OPERATION_CONFIG` selects
worker-owned shared lifetime sessions. It must be positive and no greater than
the existing `NS_POOL_OPERATION_MAX`. Omitting it retains the existing per-request
lifetime client path; no single-tenant configuration is changed.

A tenant maps to the first unsigned 32 bits of SHA-256 of its canonical UUID,
modulo the selected count. Lanes open lazily and never exceed that count per
worker, independently of tenant count or the number of held response/provider
bodies. The existing PostgreSQL pool remains the physical upper bound. The
chosen count is explicit so the deployment can measure and tune it without a
source change. A hot tenant stays on one lane; this tradeoff must be included in
capacity testing, not inferred from a distributed-tenant functional test.

Each lane serializes only short admission/registration and completion sections.
The existing full admission, tenant binding, generation check, session shared
advisory acquisition, durable marker INSERT and finished UPDATE remain intact.
Response/provider bodies run outside those transactions. PostgreSQL's reentrant
shared lock count retains a tenant lock until its final operation releases it.
Clinical SQL still uses its own normal short transactions and separate pool;
this does not introduce an additional clinical write-concurrency limit.

Both admission and completion use the existing operation connection wait budget
(`NS_POOL_OPERATION_CONNECT_TIMEOUT_MS`) for waiting in the lane queue. An
expired queued registration never starts SQL or enters its body later. A
registration that never acquired resources does not poison other operations.
Query deadlines remain PostgreSQL's existing statement timeout. An ambiguous
registration COMMIT does not enter the body. A failed or ambiguous completion
poisons that owner backend, invalidates every associated active scope through
its existing callback, and does not claim success. An owner loss is sticky for
that worker lane; it never silently reconnects under old marker ownership.

Marker RLS continues to require the exact same backend PID and birth to register
and finish an operation. Unfinished markers survive an owner death or uncertain
registration and keep restore fail-closed, even if a replacement worker uses the
same participant ID. A completed marker whose reply was lost remains completed;
its result is not rewritten to guess what happened. Restart/count changes do
not recover orphan markers. Restore recovery remains the existing explicit
lifecycle responsibility.

Lifetime sessions retain their existing metadata-only database capability. They
are not added to the observed clinical backend inventory merely to bypass the
unknown-writer check. Native tests show that adding clock-write authority causes
restore census refusal. No application-name, role-name or RLS exception is used.

The focused native discriminator compares 1/2/4 lanes through the same admission
and marker path, includes held response lifetimes, and tests actual API processes,
current authorization, B continuity, owner death/replacement and lost commit
replies. Those tests establish mechanism and safety, not a capacity envelope.
The coordinator chooses a provisional count and measures the coherent deployment
before making performance or capacity claims.
