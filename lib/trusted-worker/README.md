# Trusted worker metadata and retained settings

The evaluator and realtime are trusted multitenant workers. `postgres.create`
reads their assigned roster's scheduling metadata with one set-based SELECT.
Ordinary role-targeted SELECT policies expose that metadata across tenants.
Clinical acquisition and checkpoint/output transactions retain the existing
explicit tenant and restore-window contracts. Public API and display identities
receive no new grants or policies.

`trustedWorker` selects four metadata namespaces: `activity`, `clock`, `settings`
and `operatorPolicy`. The deployment grants helper gives the evaluator/realtime
roles SELECT on only the required columns and installs a SELECT policy for each
role on those four tables. It grants no write, owner, credential or DDL access.
Worker assignment is enforced by the worker's existing pool/placement roster;
the trusted database identity intentionally does not attest the process's slice.
There is no SECURITY DEFINER function or per-tenant discriminator loop.

`scan(tenants)` returns current activity, settings/policy versions and the durable
write-clock pair. The evaluator compares that pair with the checkpoint it really
acquired. An unchanged tenant does no settings SQL or catalogue/grant inspection.
Due clinical timers use retained settings/inputs; their existing activity,
clinical/output and restore checks remain. A changed configuration is reloaded.
Realtime retains the effective entry while the registry base and retained
settings snapshot are unchanged, avoiding repeated environment construction.

The feed's coalesced dirty map is detached before a check starts. A new hint
arriving during that check stays dirty for the following tick. The processed
checkpoint is never advanced to a hinted generation that was not acquired. The
existing periodic rotation finds a lost hint; a degraded/reconnected evaluator
feed clears the selected settings caches and reconciles in full. Current settings
snapshots also expire after ten minutes by default (`settingsRefreshMs`, configurable from 1 to 2147483647 ms), independently of version changes; the
next due operation or reconciliation reloads them. The maximum quiet reload
interval includes the configured reconciliation sweep and scheduler delay.

`lifecycle` verifies the metadata contract at boot, every ten minutes and after
failure/recovery. Its AsyncResource is created outside tenant/request scope.
Operational verification is two fixed queries per worker check, independent of
roster size. It does not run once per tenant or enter a tenant job's operation
window. A refused query invalidates retained metadata/settings and refuses new
reads until independent operational verification succeeds. Global and tenant
invalidation fence in-flight reads so an old completion cannot repopulate caches.
Closing drains the verifier/readers before the clinical connection is closed.

## Upgrade and integration

1. Install the core reader/config/schema changes and the matching deployment
   grant/config changes together. Existing configurations without `trustedWorker`
   retain their old behavior; public reader behavior is unchanged.
2. Before enabling new worker documents on an existing database, apply
   `trusted-worker/postgres.grants({namespaces,roles})` as its operator. The helper
   replaces only its deterministically named role-specific policies; existing
   public tenant policies remain. Fresh registry bootstrap applies it through the
   deployment's normal grant builder. Existing database upgrades need the same
   explicit operator step; startup does not grant itself anything.
3. Restart workers with the new documents. Their one-time readable-table inventory
   includes the declared metadata tables. Readiness refuses missing privileges or
   unexpected writes. Recovery invalidates caches and verifies before warming.
4. Freeze the combined candidate with the ongoing realtime recovery/host work;
   then run the coordinator's full/browser/enabled-corpus campaign and final
   prcheck. This lane does not change image/source pins or claim integration.

The focused native lab is `node tools/trusted-worker/native.cjs`, supplied a
`TRUSTED_WORKER_TEST_URL` for a fresh disposable PostgreSQL database. It creates
synthetic roles/tables and exercises the actual reader and registered connection.
It is a metadata/grant experiment, not full schema, clinical runtime or capacity
acceptance. `python3 tools/trusted-worker/controls.py` breaks the source properties
and restores exact bytes; outputs stay under `/tmp` by default.

Remaining performance work includes public socket authorization, retained
clinical operation/restore admission cost, feed-reader polling cost and actual
joined-runtime idle/load measurement. A metadata SELECT still visits/returns
rows proportional to its selected roster; batching alone does not make this
constant database work. Normal dirty-feed work and recovery scans must be
measured separately.

The restore/ensure policy checks retain the exact canonical PUBLIC tenant ALL
policy. They also admit explicit nonPUBLIC-role permissive SELECT USING(true)
policies with no WITH CHECK only when they cannot apply directly or through
membership to the restricted restore/provisioning caller. This validates that
caller's isolation, not a universal whitelist for every database login. Generated
grants select evaluator/realtime roles only. Worker availability and generation
also fence in-flight computation, cached model eligibility and staged realtime
activation; operational recovery cannot make an older result current. A refused
metadata reconciliation propagates to the feed and retries its dirty hints.
