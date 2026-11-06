# Selected storage read permissions

The entries router historically checked only api:entries:read while allowing
count/slice requests to select treatments or devicestatus. The selected storage
now adds its own read permission before query construction, cache access or
MongoDB I/O. The storage name is restricted to the existing three-name allowlist;
unknown names retain the entries fallback. Existing entries permission remains
required, so this does not widen any role's access.

Two HTTP tests use actual authorization/Shiro middleware and three distinct
owned MongoDB collections. Each scenario runs twice: entries-only callers get
401 and zero find/aggregate commands for the other two storages; explicitly
granted callers receive the expected counts and collection-specific slice
records; entries fallback still succeeds. The fixture uses generic entries
storage adapters for the three owned collections to isolate router permissions.
It does not claim to validate every treatment/devicestatus document format.

Before the fix, the denied-access test fails with HTTP 200; the permitted-path
test passes. Afterward both pass on Node 22/MongoDB 6 and Node 24/MongoDB 8.
Full backend and hosted checks remain required. No data or UI change; clients
using entries-only credentials for other storages must receive explicit grants.
This is separate from intentional MongoDB predicate support and query resource
limits. Rollback would reopen the permission gap and is not a recommended remedy
for a missing client permission.
