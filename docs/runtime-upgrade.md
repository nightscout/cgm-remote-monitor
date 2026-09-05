# Runtime and database support (next release)

Nightscout now requires **Node 22.23.2+ or Node 24.20.0+**, within those two LTS major lines (`^22.23.2 || ^24.20.0`). Node 20 is retired. Earlier patches, odd-numbered releases, prereleases, and Node 26 Current are not supported. The package manifest is authoritative; the startup guard uses that same range before loading application configuration or starting services.

Node 24 is recommended for new source installations (`.nvmrc` and `bin/setup.sh`). The Docker image continues to use Node 22 Alpine, updated through the official major tag. npm 10 or newer remains required; CI separately validates npm 12 on Node 24. These minimum patches reflect the supported release baseline at the time of this change, not a promise that future security updates are optional.

Official references: [Node release index](https://nodejs.org/dist/index.json), [LTS schedule](https://github.com/nodejs/Release#release-schedule). Node 22 reaches end of life on April 30, 2027; Node 24 on April 30, 2028.

## Upgrade and rollback

1. Record the running Nightscout commit/image digest, Node version, npm version, environment configuration, and deployment settings. Retain the previous application artifact and take a normal database backup. Keep API_SECRET and browser origin unchanged so credentials and local settings remain valid.
2. For source deployments, upgrade Node **before** installing this Nightscout release. With nvm, run `nvm install 24` and `nvm use 24`; verify `node --version` meets the package range. A major selector is not proof of the actual installed patch. Rebuild native dependencies with a fresh `npm ci`; do not reuse node_modules from another Node version.
3. Build and start in staging using the same configuration and a representative database copy. Check authenticated uploads, profile/treatment reads, both glucose units, chart interactions, notification acknowledgements/snoozes, and two disconnect/reconnect cycles. Compare startup and post-GC memory under matched workloads before claiming improvements.
4. For Docker, pull/build the new image and retain the old digest. Confirm the actual runtime with `docker run --rm IMAGE node --version`, then exercise application startup with the deployment's MongoDB configuration.
5. Roll back by deploying the recorded previous commit/artifact or image digest and its previous runtime/configuration. For a source rollback, run `npm ci` under that release's supported Node version. This change performs no database migration; do not restore an old database over new user data merely to roll back the runtime policy.

Do not deploy this release to a host that cannot provide a supported runtime in **both build and execution** environments.

## Deployment validation and release gate

The CI matrix tests 22.23.2, latest 22, 24.20.0, and latest 24 against MongoDB 5 and 6 (eight combinations). MongoDB 4.4 coverage has been removed. MongoDB 5/6 remain supported during the migration, but are not recommended for new deployments because they are upstream end-of-life; see the database notice below. Unsupported-Node-version tests verify early rejection through both entry points and the public boot API. Docker PR checks build and smoke-start the pruned image on native amd64 and arm64 runners.

The following remain release checks until a maintainer records actual host evidence. Updating selectors alone does **not** establish hosted compatibility:

- **Azure / Windows:** `azuredeploy.json` now selects `~24`. In the target App Service/Kudu environment, confirm this runtime is available and resolves to at least 24.20.0, then verify deployment, build, and application startup. Set `SCM_COMMAND_IDLE_TIMEOUT=300`. The legacy Azure deployment script's production-only install/global webpack behavior needs separate build/runtime cleanup; test that path before release. Do not assume legacy Windows versions in external tutorials are supported.
- **Heroku:** verify the buildpack resolves the engine range, builds with development dependencies, prunes correctly, and starts with persistent configuration. Record buildpack/stack versions and an upgrade/rollback exercise.
- **Source and development:** verify a clean locked install and production startup, development/HMR startup, and upgrade/rollback with the same saved configuration and browser storage. The Linux setup helper selects NodeSource 24; validate it on the deployment's supported distribution.

No deployment platform is retired by this change. An unavailable or unverified platform remains a release blocker until validated or explicitly retired in a separate reviewed decision. Keep this release notice linked from the next published release notes.

## MongoDB support during modernization

**MongoDB 4.4 and earlier are retired from Nightscout support and CI.** MongoDB 5.0.32+ within the 5.0 series and 6.0.27+ within the 6.0 series remain supported during the modernization migration. This is a transitional compatibility policy, not a claim of upstream security support: MongoDB 4.4 reached end of life on February 29, 2024; 5.0 on October 31, 2024; and 6.0 on July 31, 2025. See the [official lifecycle schedule](https://www.mongodb.com/legal/support-policy/lifecycles).

This change removes CI jobs and updates the support policy. It does not change the MongoDB driver, schema, connection protocol, or startup behavior, and does not migrate or delete data. An existing 4.4 connection may still work; that does not make it supported. There is no new startup version query or database permission requirement.

Before deploying the modernization release on a database currently running 4.4:

1. Record the database version, feature compatibility version (FCV), topology, authentication settings, Nightscout artifact and configuration. Take a consistent backup and verify restoration into an isolated environment.
2. Follow MongoDB's topology-specific upgrade procedure. In-place upgrades must proceed through successive major releases; do not point a newer major's container image directly at a 4.4 data volume. Review each intermediate release's compatibility changes and FCV requirements. Use MongoDB's [archived documentation](https://www.mongodb.com/docs/legacy/) for 4.4/5/6 and the [7.0 upgrade guidance](https://www.mongodb.com/docs/manual/release-notes/7.0-upgrade-standalone/) for the subsequent path; replica sets and sharded clusters have different procedures.
3. Rehearse the database upgrade independently of the Nightscout upgrade using a representative restored copy. Verify authenticated uploads, entries/treatments/profiles, indexes, stable identifiers, timezone/unit behavior, and supported Loop/Trio/AAPS clients. Retain results for the final release gate.
4. Keep application rollback and database rollback separate. Reverting Nightscout does not undo database binary or FCV changes. Agree a recovery plan using MongoDB's documented downgrade restrictions and the verified backup; account for writes made since that backup.

The follow-up database work must validate maintained MongoDB 7/8 releases with the selected driver and existing client/API fixtures before changing the recommended deployment version. Retiring 5/6 requires a separate support decision and release notice; they remain in CI during this migration. Database upgrade/restore evidence is required before final promotion of #8605. No production database is changed by this PR.
