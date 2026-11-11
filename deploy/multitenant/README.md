# Multitenant deployment test fixture

The Compose deployment of multitenant Nightscout lives in
[nightscout/nightscout-deploy](https://github.com/nightscout/nightscout-deploy)
(`bindings/compose/multitenant`). Operators prepare, build, bootstrap and run
it from there; its README and credential guide are the operator documentation.

This directory keeps only the modules core's own tests load. The path is kept
because the deploy repository's overlay helper places its tree here over a core
checkout, so the same relative `../../lib` requires resolve in both.

| file | loaded by |
|---|---|
| `config.js` | the deployment plan's layout and grants: `tests/admin-role.test.js`, `tests/admin-role-ownership.integration.test.js`, `tests/admin-lifecycle-fit.integration.test.js` |
| `demo.js` | `tests/compose-deployment-protocol.test.js` (demonstration protocol and its controls) |
| `health.js` | `tests/compose-deployment-protocol.test.js` (container health probe) |
| `restore.js` | `demo.js`; `tests/admin-lifecycle-fit.integration.test.js` (restore driver beside the admin role) |
| `ui.js` | `tests/compose-ui.test.js` (public UI boundary) |

There is nothing here to run as a deployment. A change to one of these files
that the deployment depends on is carried to nightscout-deploy in the same
cycle.
