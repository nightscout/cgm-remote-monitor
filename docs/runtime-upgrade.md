# Runtime and database support (next release)

Nightscout requires **Node 22.23.4+ within Node 22, 24.22.1+ within Node 24, or 26.12.1 and later** (`^22.23.4 || ^24.22.1 || >=26.12.1`). Prereleases are excluded. The package manifest is authoritative; the startup guard checks that same range before loading application configuration or starting services.

## Security floor: CVE-2026-111497

The October 21, 2026 [Node security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) fixes a Brotli decoder out-of-bounds write that can cause a crash, disclosure of process memory, or remote code execution when an application decompresses attacker-controlled input. The fixed releases are [22.23.4](https://nodejs.org/en/blog/release/v22.23.4), [24.22.1](https://nodejs.org/en/blog/release/v24.22.1) and [26.12.1](https://nodejs.org/en/blog/release/v26.12.1).

This supersedes the earlier compatibility-only floor of `^22.12 || >=24`. Those versions can run the application, but the old range also permits vulnerable runtimes. Node 20, 23 and 25 are excluded; unpatched Node 22, 24 and 26 releases are refused at startup. The `>=26.12.1` arm preserves the existing policy of accepting later stable major releases; it does not establish compatibility with a future runtime before testing it.

The current Express 4/body-parser 1 request parser rejects Brotli request bodies, but Nightscout Connect's Axios client automatically decompresses Brotli responses. Blocking inbound `Content-Encoding: br` alone therefore does not remove the risk. Upgrade the runtime used by both the build and the running application.

Node 24 LTS is recommended for new source installations. `.nvmrc` selects 24.22.1, and the NodeSource setup helper selects the 24 line; verify the installed patch. Both Docker stages use `node:24.22.1-alpine`; source deployments can still use patched Node 22 under the package's runtime policy. Update those pins as newer security releases arrive, rebuild images, and redeploy existing containers: changing this repository does not patch a running process. npm 10 or newer remains required; CI separately validates npm 12 on Node 24.

## Upgrade and rollback

**Check every running runtime before upgrading.** Sites on an older patch of Node 22, 24 or 26, or on Node 20, 23 or 25, must upgrade. A floating major tag or hosting selector does not prove the deployed patch is fixed.

1. Record the running Nightscout commit/image digest, Node version, npm version, environment configuration, and deployment settings. Retain the previous application artifact and take a normal database backup. Keep API_SECRET and browser origin unchanged so credentials and local settings remain valid.
2. For source deployments, upgrade Node **before** installing this Nightscout release. With nvm, run `nvm install` and `nvm use` from the checkout to select its patched `.nvmrc` version; verify `node --version` meets the package range. A major selector is not proof of the actual installed patch. Rebuild native dependencies with a fresh `npm ci`; do not reuse node_modules from another Node version.
3. Build and start in staging using the same configuration and a representative database copy. Check authenticated uploads, profile/treatment reads, both glucose units, chart interactions, notification acknowledgements/snoozes, and two disconnect/reconnect cycles. Compare startup and post-GC memory under matched workloads before claiming improvements.
4. For Docker, retain the old digest, rebuild with `docker build --pull` against the patched base image, and redeploy the resulting image. Confirm the actual runtime with `docker run --rm IMAGE node --version`, then exercise application startup with the deployment's MongoDB configuration.
5. Roll back by deploying the recorded previous commit/artifact or image digest and its previous runtime/configuration. For a source rollback, run `npm ci` under that release's supported Node version. This change performs no database migration; do not restore an old database over new user data merely to roll back the runtime policy.

Do not deploy this release to a host that cannot provide a supported runtime in **both build and execution** environments.

## Deployment validation and release gate

Maintainer direction on 2026-09-08 assigns actual production hosting, vendor
accounts and device testing to the maintainer after automated branch completion.
The [completion evidence](test-specs/modernization-completion.md) records automated
results separately; no live host or physical-device pass is implied.

Ordinary CI tests the Node edges (22.23.4 and latest 26) and the MongoDB edges (5.0 and 8.0) on the diagonal, 22.23.4 against 8.0 and 26 against 5.0, plus the newest pair (26 against 8.0.29), with the two transitional required lanes (24/6 and 22/6). Tests that need no database run on both Node edges. A weekly extended run tests every pair. Every browser engine runs once on Node 26. MongoDB 4.4 remains unsupported and has no CI lane. Manual extended validation adds the other patched Node floors/latest aliases against both MongoDB edges and all browsers. See [CI coverage and manual release checks](../CONTRIBUTING.md#ci-coverage-and-manual-release-checks). Boundary tests reject the preceding vulnerable patch on each Node line through both server entry points and the public boot API. MongoDB 5/6 remain supported during the migration but are upstream end-of-life; use MongoDB 7.0 or 8.0 for new deployments. Docker PR checks build and smoke-start the pruned image on native amd64 and arm64 runners.

The following remain release checks until a maintainer records actual host evidence. Updating selectors alone does **not** establish hosted compatibility:

- **Azure / Windows:** `azuredeploy.json` now selects `~24`. In the target App Service/Kudu environment, confirm this runtime is available and resolves to Node 24.22.1 or later within Node 24 in both build and execution environments, then verify deployment, build, and application startup. Set `SCM_COMMAND_IDLE_TIMEOUT=300`. The Azure script now installs locked build dependencies with `npm ci --include=dev`, builds in postinstall, and prunes with `npm prune --omit=dev --ignore-scripts`; validate that complete path on the target host before release. Do not assume legacy Windows versions in external tutorials are supported.
- **Heroku:** verify the buildpack resolves the engine range, builds with development dependencies, prunes correctly, and starts with persistent configuration. Record buildpack/stack versions and an upgrade/rollback exercise.
- **Source and development:** verify a clean locked install and production startup, development/HMR startup, and upgrade/rollback with the same saved configuration and browser storage. The Linux setup helper selects NodeSource 24; validate it on the deployment's supported distribution.

No deployment platform is retired by this change. An unavailable or unverified platform remains a release blocker until validated or explicitly retired in a separate reviewed decision. Keep this release notice linked from the next published release notes.

## MongoDB support during modernization

**MongoDB 4.4 and earlier are retired from Nightscout support.** Nightscout supports MongoDB 5.0 through 8.0: 5.0.32+ within the 5.0 series, 6.0.27+ within the 6.0 series, and MongoDB 7.0 and 8.0. CI tests the edges of that range, 5.0 and 8.0. This is a transitional compatibility policy, not a claim of upstream security support: MongoDB 4.4 reached end of life on February 29, 2024; 5.0 on October 31, 2024; and 6.0 on July 31, 2025. See the [official lifecycle schedule](https://www.mongodb.com/legal/support-policy/lifecycles).

This change removes CI jobs and updates the support policy. It does not change the MongoDB driver, schema, connection protocol, or startup behavior, and does not migrate or delete data. An existing 4.4 connection may still work; that does not make it supported. There is no new startup version query or database permission requirement.

### Docker Compose default in Nightscout 16.0.0

The bundled `docker-compose.yml` now selects **mongo:6.0.27**, replacing the
**mongo:5.0.32** default shipped through 15.0.9. MongoDB 5 remains supported during
migration; changing the example default does not require externally managed
MongoDB 5 deployments to upgrade immediately.

For an existing Compose deployment, this is a database major-version upgrade,
not just a Nightscout image update. Back up and rehearse against a restored copy
before recreating the Mongo service. Follow MongoDB's standalone 5-to-6 upgrade
procedure (or the matching replica/sharded procedure), including the required
5.0 feature compatibility version before starting 6.0. Retain the existing
`NS_MONGO_DATA_DIR`/data mount; do not delete the data directory or volume.
Verify Nightscout reads, uploads, profiles and settings after the upgrade before
raising FCV to 6.0. An application rollback does not downgrade MongoDB or FCV;
use the documented database recovery procedure and your verified backup.

See MongoDB's [archived 6.0 standalone upgrade procedure](https://github.com/mongodb/docs/blob/v6.0/source/release-notes/6.0-upgrade-standalone.txt)
and [legacy documentation](https://www.mongodb.com/docs/legacy/). The existing
MongoDB end-of-life and final upgrade/restore validation gates above still apply.

The [owned upgrade and recovery rehearsal](test-specs/database-upgrade-recovery.md)
now verifies successive MongoDB 5→6→7→8 standalone upgrades and fresh-volume
restoration of the original and final backups with the actual Nightscout
application. It is automated fixture evidence, not validation of a deployment's
backup or topology. Deployment rehearsal remains maintainer-owned.

Before deploying the modernization release on a database currently running 4.4:

1. Record the database version, feature compatibility version (FCV), topology, authentication settings, Nightscout artifact and configuration. Take a consistent backup and verify restoration into an isolated environment.
2. Follow MongoDB's topology-specific upgrade procedure. In-place upgrades must proceed through successive major releases; do not point a newer major's container image directly at a 4.4 data volume. Review each intermediate release's compatibility changes and FCV requirements. Use MongoDB's [archived documentation](https://www.mongodb.com/docs/legacy/) for 4.4/5/6 and the [7.0 upgrade guidance](https://www.mongodb.com/docs/manual/release-notes/7.0-upgrade-standalone/) for the subsequent path; replica sets and sharded clusters have different procedures.
3. Rehearse the database upgrade independently of the Nightscout upgrade using a representative restored copy. Verify authenticated uploads, entries/treatments/profiles, indexes, stable identifiers, timezone/unit behavior, and supported Loop/Trio/AAPS clients. Retain results for the final release gate.
4. Keep application rollback and database rollback separate. Reverting Nightscout does not undo database binary or FCV changes. Agree a recovery plan using MongoDB's documented downgrade restrictions and the verified backup; account for writes made since that backup.

MongoDB 7.0 and 8.0 are the maintained releases to use for new deployments. Retiring 5/6 requires a separate support decision and release notice; 5.0 remains the floor CI tests. Database upgrade/restore evidence is required before final promotion of #8605. No production database is changed by this PR.


## MongoDB AWS credentials in the driver migration candidate

The driver migration preserves existing `MONGODB-AWS` connection strings by
adapting URI credentials to a credential provider. URI credentials and session
tokens retain precedence over `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`AWS_SESSION_TOKEN`; those variables remain available as fallbacks. Nightscout
does not change those environment variables. Instance/container metadata
credentials use the AWS SDK when no static access key is configured.

The AWS credential-provider package is included in the production dependency
set because the new driver requires it. Ordinary MongoDB client construction
loads no AWS SDK modules. Live Atlas IAM/role verification is still a release
gate; local challenge/metadata tests do not establish a deployment's IAM access.
For application rollback, restore the driver, URI parser, SOCKS and AWS SDK
manifest/lockfile plus the connection adapter together. No database binary,
FCV or stored-data migration is performed by this adapter.

## API v1 profile uploads

Profile POST requests still accept a single object or an array of objects.
Malformed entries and batches above 10,000 records now return HTTP 400 before
any profiles are stored. Split larger profile imports into smaller requests.

## MongoDB query filters

This release rejects `$where`, `$function` and `$accumulator` when used to
submit JavaScript through Nightscout database queries. Replace such filters
with ordinary MongoDB comparison, logical or aggregation operators. Explicit
literal values containing these names remain data. Profile filter requests
rejected by this validation return HTTP 400 with an explanatory message;
other profile storage failures return a generic HTTP 500.

### Count and slice storage permissions

The legacy `/api/v1/count/:storage/where` and `/api/v1/slice/:storage/...`
routes now require `api:treatments:read` or `api:devicestatus:read` when that
storage is selected, in addition to the existing `api:entries:read` gate.
An entries-only token can no longer read those other collections through these
routes. Grant the specific additional read permission to clients that need it.
Entries reads and the existing unknown-storage fallback remain unchanged.

### Slice responses use the requested collection

Type-only treatment/device-status slice requests no longer return entries-cache
records. These requests now read the selected collection. Entries slices keep
their existing cache path; selected-storage permission requirements still apply.

## Legacy Dexcom bridge retirement

The local `share2nightscout-bridge` engine is removed in favour of Nightscout
Connect's Dexcom Share source. Deprecated legacy overrides no longer select an
old engine: `DEXCOM_BRIDGE_USE_LEGACY`, its Azure prefix, and legacy extended
settings cannot re-enable it; if `DEXCOM_BRIDGE_USE_LEGACY` is still set,
Nightscout logs that it is ignored. MiniMed is retired separately, below.

| Existing setting | Connect setting/behavior |
| --- | --- |
| `BRIDGE_USER_NAME` | Fallback for `CONNECT_SHARE_ACCOUNT_NAME` |
| `BRIDGE_PASSWORD` | Fallback for `CONNECT_SHARE_PASSWORD` |
| `BRIDGE_SERVER=US` | Fallback `CONNECT_SHARE_REGION=us` |
| `BRIDGE_SERVER=EU` | Fallback `CONNECT_SHARE_REGION=ous` |
| Custom `BRIDGE_SERVER` hostname | Fallback `CONNECT_SHARE_SERVER` |
| No server override | Connect's default US endpoint |
| `BRIDGE_INTERVAL`, `BRIDGE_MAX_COUNT`, `BRIDGE_FIRST_FETCH_COUNT`, `BRIDGE_MAX_FAILURES`, `BRIDGE_MINUTES` | Retired; Connect owns polling, backfill and retries |

Complete legacy credentials enable `CONNECT_SOURCE=dexcomshare` when no source
is selected. Explicit Connect credentials, region and server take precedence.
Incomplete legacy credentials do not enable Connect. Prefer explicit Connect
settings going forward and remove obsolete BRIDGE settings after validation.

Connect currently supports one source per instance. Complete BRIDGE credentials
alongside a different CONNECT_SOURCE now produce an actionable configuration
error without starting either ingestion source. Select Dexcom Share, or arrange
separate Dexcom ingestion and remove the obsolete BRIDGE credentials; the
application must not silently discard either configured feed.

Rehearse the switch using owned nonproduction data. Verify region/custom server,
authentication, repeated uploads, backfill and duplicate handling. Connect marks
new entries with device `nightscout-connect` rather than `share2`. There is no
bulk history rewrite, but overlapping backfill updates matching readings,
including their device field, while preserving database identifiers. Do not run old and new ingestion simultaneously.
Private TLS endpoints must have certificates trusted by the Node runtime; the
legacy engine's certificate-verification bypass is not retained.

Rollback requires a previous Nightscout artifact with the legacy engine plus
its known configuration; flipping the removed override cannot restore
it. Retaining an old artifact does not resolve the legacy TLS defect. No MongoDB
binary/FCV or schema change is part of this retirement.


## Legacy MiniMed mmconnect retirement

The local `mmconnect` plugin and `minimed-connect-to-nightscout` package are
retired in favour of Nightscout Connect. Add `connect` to `ENABLE`, then configure:

```text
CONNECT_SOURCE=minimedcarelink
CONNECT_CARELINK_USERNAME=<CareLink account username>
CONNECT_CARELINK_PASSWORD=<CareLink account password>
CONNECT_COUNTRY_CODE=<two-letter country where the account was created>
CONNECT_CARELINK_REGION=eu
```

Use `us` instead of `eu` for the US service. `CONNECT_CARELINK_SERVER` can select
a custom endpoint; preserve an existing explicit setting. Carepartners following
a patient can set `CONNECT_CARELINK_PATIENT_USERNAME` explicitly.

Complete legacy `MMCONNECT_USER_NAME` and `MMCONNECT_PASSWORD` values are accepted
as a migration convenience, with explicit Connect settings taking precedence.
Legacy `MMCONNECT_SERVER` values EU/US (case-insensitive) map to eu/us; a custom
server maps to `CONNECT_CARELINK_SERVER`. You must supply `CONNECT_COUNTRY_CODE`:
a service region is not an account country. No replacement starts if that value
is missing, and the whole site shows an error page naming the settings to
add; the `CONNECT_*` settings are read only when `connect` is in `ENABLE`. After validating ingestion, remove obsolete MMCONNECT variables.

Connect supports one configured source. Legacy MiniMed credentials alongside a
different Connect source, or alongside legacy Dexcom credentials, produce a boot
error rather than silently starting only one feed. Select the intended Connect
source and remove obsolete credentials, or migrate the additional feed to a
separately configured uploader before upgrading.

`MMCONNECT_INTERVAL`, `MMCONNECT_MAX_RETRY_DURATION`, `MMCONNECT_SGV_LIMIT`,
`MMCONNECT_VERBOSE` and `MMCONNECT_STORE_RAW_DATA` no longer control ingestion.
Connect uses its own scheduling, session refresh and retry behavior. It does not
continue the old optional `carelink_raw` storage feature. Existing database
records and historical glucose/pump data are not deleted or rewritten.

This branch pins nightscout-connect `0.1.0`, which contains commit
`c962a13fee9a7a5ca160ab5e3fb231d35cadf294`: the logging fix from upstream PR #64 and
the data fixes from #65.
Provider operation labels replace raw credential, cookie, token and patient-data
logs. CLI capture output and other providers are outside that logging fix.

Before release, validate the actual account/service region, authentication,
session refresh, glucose timestamps/trends, pump battery/reservoir/IOB, duplicate
handling across cutover and reconnect behavior. Owned configuration/logging
fixtures do not prove live CareLink compatibility. Retain the previous release
artifact and configuration plus a database backup for rollback; do not run both
local engines against the same feed. Never downgrade MongoDB as a proxy for an
application rollback.


Connect may backfill older glucose readings instead of applying the retired
engine's 20-minute stale-response cutoff. Measurement timestamps are preserved;
old pump status must not be relabelled with fetch time. The pinned data fix also
preserves valid readings when trend metadata is absent or mismatched, restores
legacy nested IOB/uploader fields and avoids repeated status across cutover.
Device identifiers change from `connect-<family>` to
`nightscout-connect://minimedcarelink/<family>`; filters that match the old device
name need updating. Owned regression fixtures cover these changes; verify actual
account/device behavior before release.

## Updated timezone rules

The modernization candidate updates Moment Timezone to 0.6.3 with IANA timezone
data 2026c. Local clock labels and profile-zone conversion can change where that
data corrects historical rules or models new clock policies. Stored UTC timestamps
are not rewritten by the dependency update.

Affected zone groups include Morocco/Western Sahara, Alberta-related aliases,
British Columbia, Moldova and historical Baja California. The
[IANA release notes](https://github.com/eggert/tz/blob/2026c/NEWS) describe the
modeled changes. The package's aliases follow their linked canonical zones;
this is not an independent guarantee of current policy for every alias region.
Verify the configured profile timezone and relevant local-time displays when
upgrading an affected installation.

Server timezone data includes historical corrections; the existing browser
bundle retains only 2015–2035 data. This update does not broaden that browser
range or resolve the separately tracked spring-DST schedule-selection issue.
Application rollback restores the previous timezone rules without rewriting
stored timestamps. See the [validation scope](test-specs/moment-timezone-refresh.md).
