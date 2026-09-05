# Node runtime upgrade (next release)

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

The CI matrix tests 22.23.2, latest 22, 24.20.0, and latest 24 against MongoDB 4.4, 5, and 6. The older MongoDB jobs are regression coverage, not a new recommendation to deploy end-of-life database versions. Unsupported-version tests verify early rejection through both entry points and the public boot API. Docker PR checks build and smoke-start the pruned image on native amd64 and arm64 runners.

The following remain release checks until a maintainer records actual host evidence. Updating selectors alone does **not** establish hosted compatibility:

- **Azure / Windows:** `azuredeploy.json` now selects `~24`. In the target App Service/Kudu environment, confirm this runtime is available and resolves to at least 24.20.0, then verify deployment, build, and application startup. Set `SCM_COMMAND_IDLE_TIMEOUT=300`. The legacy Azure deployment script's production-only install/global webpack behavior needs separate build/runtime cleanup; test that path before release. Do not assume legacy Windows versions in external tutorials are supported.
- **Heroku:** verify the buildpack resolves the engine range, builds with development dependencies, prunes correctly, and starts with persistent configuration. Record buildpack/stack versions and an upgrade/rollback exercise.
- **Source and development:** verify a clean locked install and production startup, development/HMR startup, and upgrade/rollback with the same saved configuration and browser storage. The Linux setup helper selects NodeSource 24; validate it on the deployment's supported distribution.

No deployment platform is retired by this change. An unavailable or unverified platform remains a release blocker until validated or explicitly retired in a separate reviewed decision. Keep this release notice linked from the next published release notes.
