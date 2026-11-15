# Multitenant deployment contract

The Compose deployment and its UI, health, demonstration and restore helpers
live in [nightscout/nightscout-deploy](https://github.com/nightscout/nightscout-deploy)
under `bindings/compose/multitenant`. Deployment-specific tests live beside them.

Core publishes the [plan contract](../../docs/multitenant-plan-contract.md),
including schema, CLI and provisioning checks. Its own tests use the small
[synthetic registry plan](../../tests/fixtures/multitenant-plan.js). Native
restore integration reads the exact externally pinned deployment plan and
operator through `tests/fixtures/canonical-admin-restore.js`; it keeps no copy.

The directory remains the overlay mount point so deployment modules can resolve
the selected core libraries. It contains no runnable deployment or helper copy.
