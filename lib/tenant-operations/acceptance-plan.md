# Deployment recovery acceptance

Database administrators exercise PostgreSQL recovery against their selected deployment
configuration and confirm that retained Vault keys can decrypt preserved ciphertext.

The application’s migration gate checks a reviewed old ledger against its target,
preserves existing rows and verifies that the old binary refuses a newer schema.
Tenant recovery checks use the original tenant and compare ciphertext, row identity,
generation fences and foreign-tenant state. The current executable PostgreSQL cases
are in [tenant operations integration tests](../../tests/tenant-operations.integration.test.js).
The separate [whole-C SQL fixture](../../tools/lab/tenant-whole-c/README.md) exercises
the historical migration, tenant lifecycle and concurrency scenarios.
