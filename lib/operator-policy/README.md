# Persistent operator policy

This is a dormant control-plane store. It adds no route, serving role, tenant
resolution or startup migration. Operator authentication and authorization are
injected through `authorizeManagement`; caller-supplied names do not prove
authority.

`createOperatorPolicy({store, authorizeManagement})` exposes `read(context)`
and full-document `replace(context, expectedGeneration, policy)`. A policy is
a bounded JSON object. The first write uses generation 0 and creates generation
1; later writes must match the current generation and increment it. The
PostgreSQL adapter stores the current document and last writer for each tenant.
Its separately reviewed schema is
`lib/operator-policy/postgres-candidate.json`; it is not applied at startup.

Settings and subject-grant services read the persisted document through their
injected policy callbacks. The callback must return the generation with the
settings rules or operator grant ceiling. The owner adapter takes a
tenant-specific transaction advisory lock before checking the generation and
holds it through commit. Policy replacement takes the same lock before updating
the row. Therefore,
either the owner transaction commits first under the generation it checked, or
the policy update commits first and the stale owner transaction refuses with
`POLICY_GENERATION_CONFLICT`. This applies to settings replacement, settings
rollback and subject-grant replacement.

The operator connection can read, insert and update the policy row. Owner
connections receive read-only access to that row plus their existing
tenant-bound table grants. Both use `NOSUPERUSER NOBYPASSRLS` credentials and
forced tenant RLS. Keep operator credentials off owner request paths. The
injected service authorization is still required; PostgreSQL row privileges
alone are not operator authentication.

No product schema is enabled by this candidate. Operators must separately
review and apply it, create isolated roles, and compose their trusted settings
and subject-grant callbacks from its current document. Code grant floors remain
separate inputs. Deployment acceptance, route authentication, policy history
and serving-role integration remain outside this slice.
