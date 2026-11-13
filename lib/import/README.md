# One-time entries import

`node tools/import-entries.js` populates one PostgreSQL tenant from a Nightscout
source API. It is a one-shot bootstrap, not the ongoing NS-to-NS synchronization
pipeline. The migration and tenant schema must already be applied with the
operator migration runner; the importer never runs schema changes.

Required environment:

- `NS_SOURCE_URL`: HTTPS origin of the source Nightscout instance.
- `NS_SOURCE_READ_TOKEN`: bearer token with `api:entries:read`; it is never
  written to a checkpoint or log.
- `NS_TARGET_POSTGRES_URL`: application-role connection string.
- `NS_TARGET_POSTGRES_NAMESPACE`: target schema containing `entries`.
- `NS_IMPORT_TENANT_ID`: canonical UUID for the target tenant.

Optional `NS_IMPORT_PAGE_SIZE` defaults to 100 and is capped at 1000. Responses
are limited to 32 MiB and the run is capped at 1,000,000 records. Each page is
written in one tenant-bound transaction. A rerun starts at the beginning and
safely upserts already imported identities; there is no durable checkpoint or
serving-time dependency. Repeated textual IDs across baseline pages fail closed.

The baseline reads live entries through `/api/v3/entries` with bounded
`limit`/`skip` pages, including legacy rows without `srvModified`. A
best-effort `/api/v3/entries/history/{lastModified}` pass catches updates and
soft-delete markers made during the baseline. Permanent deletions have no
tombstone and cannot be reconstructed. The baseline is not snapshot-isolated:
source writes can shift offset-page boundaries, so history is best-effort
reconciliation, not proof of a complete point-in-time copy. Source IDs remain
strings; duplicate textual IDs in one page are refused rather than silently
merged. Credentials, source records and response bodies are never printed.
