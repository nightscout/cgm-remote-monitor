# Tenant operation window

The multitenant serving composer binds each request or worker job to the current tenant generation. A short read-only control transaction admits the tenant before the JavaScript body starts. Nested work inherits that generation. The lifetime pool still bounds control sessions and detects their loss. An application body creates no durable participation marker. Graceful process shutdown waits for its own active work.

Each lower transaction acquires the tenant's nonblocking, transaction-scoped shared bigint advisory lock. It reads the bound tenant row in the same transaction and checks the lock key, active phase, expected generation and any selected pool ownership. PostgreSQL holds that lock through COMMIT or ROLLBACK. Restore uses its exclusive form for data replacement.

Suspension commits the generation change before replacement. Writable transactions use a second, short lock to order suspension against the last generation comparison and COMMIT. It uses the same tenant key split across PostgreSQL's separate two-integer advisory key space. An effect tries the shared lock before its final read. The suspension claim tries the exclusive form before updating the row. A conflict or generation change refuses the effect with a retryable suspension error. The application does not queue writes for restore.

A writable READ COMMITTED transaction obtains the replacement lock before its generation SELECT. PostgreSQL takes a fresh statement snapshot for that SELECT and again for the final generation comparison. Writable repeatable and imported snapshots compare their historical lifecycle row with a separate control session's current observation at entry and completion.

Under an authenticated tenant scope, `connection.readOnlyTransaction(fn)` runs the callback on a fresh REPEATABLE READ READ ONLY transaction. Its admission statement binds the tenant, takes the shared replacement lock and reads the lifecycle row. Each data query sees that admission snapshot. Suspension can advance the generation while the reader runs. Replacement waits for the reader's transaction to end, and the read result may arrive later. Read completion checks the physical client and operation scope. It omits the writer's final generation lock and SELECT. A read invoked inside an existing writable transaction shares that transaction and its commit fence. The dedicated display-settings reader retains its independent current admission and driver checks.

The all-zero metadata binding requires a database-confirmed read-only transaction. It cannot serve a tenant. Physical backend admission checks the datastore, principal, role flags, grant surface, schema and forced row security. New physical backends, recovery and operational verification repeat structural admission. Current actor authorization, forced row security, generation and actual COMMIT remain effect-time checks. Privileged schema or role changes require re-admission.

Restore invalidates cached tenant state and old application scopes before activation. New SQL from an old scope refuses. A response for a write that already committed can finish after restore. The supported alarm handoff retains queued alarms and their origin generation independently of application responses. Native replication receipt keeps separate source and owner admission for accepted input.

## Backend admission and recovery

Protected DDL and grant expansion require deployment/migration to retire affected
serving cohorts and re-admit them. Arbitrary trusted administrator schema, policy,
ledger or extra-grant changes on an already admitted backend no longer guarantee
custom rejection on its next transaction. PostgreSQL still enforces actual revoked
privileges on executed commands; this is not equivalent to detecting a DBA who
weakens a policy while leaving SELECT permitted. CDC does not observe every role
or DDL mutation. New/reconnected backend admission rejects unsafe structure.
Ordinary runtime roles cannot alter protected control-owner objects or create in
application schemas. Database TEMP, self-password and permitted session defaults
are narrower capabilities; qualified SQL and fixed search paths remain required.

Read-only admission checks the exact lifecycle migration ledger, column shapes,
defaults, keys, constraints, policies, helper definition and grants, relation
identities and shared schema/table/helper owner. That owner must be a dedicated
nonlogin, nonelevated role. Callers cannot own these objects, inherit elevated
roles or CREATE schemas/database objects. The dedicated lifetime role needs
schema USAGE; SELECT on windows, operations and schema_migrations; column INSERT
on operations(tenant_id,operation_id,generation); column UPDATE on
operations(finished); and EXECUTE on the birth helper. Table-level mutation,
foreign relation/sequence writes and execution of other non-system functions
refuse, including effective privileges inherited through PUBLIC or memberships.
Lower data roles need only USAGE and SELECT on these control relations, with no
operation writes or helper EXECUTE. Their clinical-data grants remain separate.
A table name is not authority to create or adopt unknown schema. The operation-window native suite exercises physical admission with the deployment grants.

A selected process retains the existing lifecycle catalogue and privilege contract. Legacy observation and clearance can inspect old operation rows. New serving bodies do not insert or complete rows. Health and recovery use the existing bounded control sessions. Recovery invalidates scopes on session loss and admits the exact datastore and catalogue before resuming work.

R74 disqualifies clock-only fences and tenant-local sequence rewind. A covered
counter and current CACHE1 metadata alone do not prove old backend caches empty.
Any future no-sequence-mutation import must retain exact artifact ordinals and
prove both cache history/backend conditions and a covered effective next-value
floor; otherwise refuse. No setval/ALTER/renumbering workaround is enabled here.

Catalogue admission compares a bounded structural SQL representation. It preserves
boolean grouping, literal contents and quoted identifier case. Only the selected
lifecycle tables/helper and named pg_catalog builtins admit their corresponding
qualifiers. Unknown syntax and missing catalogue fields refuse admission; explicit
SQL NULL remains distinct from malformed or absent metadata. This comparison does
not infer general SQL equivalence.
