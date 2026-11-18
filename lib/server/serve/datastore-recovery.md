# Datastore recovery in a serving role

A serving role periodically checks whether its operation window can still admit
tenant work. A failed check makes the role unavailable. A bounded supervisor
then either restores service under the existing contracts or stops the process
for its deployment's recovery policy. Process liveness is not tenant readiness.

On a same-store postmaster restart the role rechecks the datastore identity,
drops old tenant state and readmits the same store. Storage pools follow the
admitted identity before tenants warm again. Each pool's configured size bounds
the connections it can open; there is no separate per-process connection plan.
A role that cannot recover within its configured bound stops with a nonzero
outcome; that does not prove that a replacement process can safely start.

Recovery accepts a new postmaster only when database name/OID, server
address/port, and admitted catalogue identities still match. It does not adopt
another store or bypass fresh authority checks. Unfinished operation markers
remain unchanged and uncertain. Audited restore/resume clearance is a separate
capability.

Window adoption can succeed before storage-pool readoption or the final probe
fails. The cohort remains unavailable during that partial recovery. Its obligation
to publish a new participant incarnation survives retries until recovery is
published successfully. Old pre-outage participant pins then refuse without
invalidating the current role state. A healthy later probe does not rotate the
incarnation again. This does not clear transport or connection-credit uncertainty.

Each probe/recovery step has a deadline. Timeout cancels its authority to drop
more tenant state or adopt a new identity. The physical step remains tracked
until it settles; retries cannot start overlapping steps. The operation window
checks cancellation again after asynchronous state invalidation and immediately
before identity adoption. Required due-time work and clinical completion remain
separate observations.

Shutdown first freezes construction and cancels recovery authority. If a timed-out
physical step remains unresolved, supervisor close refuses with
`DATASTORE_RECOVERY_DRAIN_UNCONFIRMED` rather than waiting forever before pools
can close. Serving shutdown still closes contexts, the operation window and its
pool, but refuses graceful retirement. Eventual I/O completion does not erase
that failed shutdown verdict. Forced process termination and resource disposition
remain deployment responsibilities.

Dropping tenant startup state with `warm: false` removes queued initialization,
cancels selected pending tickets and invalidates older rewarm callbacks. It does
not cancel already running I/O or release its credits. Explicit resume schedules
fresh bounded warm work after readmission.

The source checks use recording dependencies and actual source modules. Native
PostgreSQL restart, selected-controller epoch disposition, clinical behavior and
capacity require the coordinator's exact frozen deployment qualification.
