# Maintained MongoDB validation

Add full backend and client-core CI jobs for MongoDB Community 7.0.40 and
8.0.29 on the exact Node 22.23.2 and 24.20.0 floors. Keep the existing eight
Node/MongoDB 5/6 jobs unchanged. Both Docker validation and publication depend
on the maintained-server jobs too, so their failure cannot be ignored by
publishing. Each job uses an isolated service; no deployment database is
upgraded by CI.

The initial baseline is integration commit 5cada7ff with mongodb driver
5.9.2. Official download metadata and Docker Hub tags were checked on
2026-09-06. Local macOS arm64 archives were SHA-256 verified; buildInfo confirms
server versions. Local servers use separate loopback ports/data directories
and every suite uses unique disposable test databases.

This is compatibility evidence gathering, not a new minimum-version policy
or a blanket server/driver support claim. Full results must cover storage,
API/client fixtures, identifiers, partial failures and reconnect behavior.
Successful buildInfo/ping alone is insufficient. Driver vendor compatibility,
replica-set/Atlas behavior, backup/restore and sequential server upgrade plus
rollback remain separate release gates before recommending migration.

MongoDB 5/6 remain supported during migration. No feature, schema or connection
configuration changes in this PR. Rollback removes the additional CI jobs;
there is no production data migration to reverse.
