# Tenant generation scope

A role admits work against the tenant’s active generation in PostgreSQL. It keeps that generation in the asynchronous request scope. Each lower data transaction takes a shared transaction-level advisory lock and checks the lifecycle row. A restore holds the exclusive lock for the same tenant before replacing data. Requests for other tenants use their own keys.

The role observes the generation again on its next admission. When the generation changes, it retires its cached tenant state before admitting new work. A lost or changed authority invalidates pending scope receipts. See [the implementation](generation-scope.js) and [the restore protocol](maintenance-window.md).
