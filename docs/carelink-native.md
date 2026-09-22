# Native CareLink — work-in-progress local evaluation

This branch is an implementation for local testing, not a production release.
It moves the CareLink connection UI, OAuth credentials and importer in-tree.
Other `nightscout-connect` drivers stay on the existing package. No Medtronic
partnership, custom OAuth callback registration, external browser service or
additional public port is required. Compatibility with Medtronic's login and
API remains unofficial and can change.

## Try it in an isolated local instance

Prerequisites: Git and Docker with Compose, an Internet connection, and enough
memory for the existing app plus 512–768 MiB of browser headroom. The supplied
test setup permits 1536 MiB for Nightscout and 512 MiB for MongoDB.

```sh
git clone --branch wip/carelink-native --single-branch https://github.com/nightscout/cgm-remote-monitor.git nightscout-carelink-native
cd nightscout-carelink-native
docker compose -f compose.carelink.yml up --build -d
```

Open <http://localhost:1337>. Authorize Nightscout with the **local-test-only**
API secret `carelink-local-testing-only`, then choose **Data sources** in the
menu (or **Admin Tools → Data sources — Medtronic CareLink**). Select the country
in which your CareLink account is registered and choose **Connect Medtronic**.
Sign in on the displayed Medtronic page, complete any verification yourself,
then confirm the account whose data you want to import.

The Compose port is bound only to `127.0.0.1`. The default secret is deliberately
public and only suitable for this isolated localhost evaluation. You can use a
different secret by setting `API_SECRET` before starting Compose. Do not publish
this test deployment to the Internet. A real hosted deployment needs HTTPS and
its own strong secret. The named Mongo volume is separate from existing
Nightscout databases; do not point the first evaluation at your production DB.

To stop the evaluation without removing its saved connection or data:

```sh
docker compose -f compose.carelink.yml down
```

Start it again with `up -d`. Its connection is encrypted in MongoDB and should
resume automatically. Keep the same `API_SECRET`; changing it requires a new
CareLink login. `Disconnect` removes local OAuth credentials and stops native
imports, but keeps historical entries/treatments. It does not sign you out of
Medtronic on other devices or claim to revoke every Medtronic session.

## User and source behaviour

- No `ENABLE=connect`, `CONNECT_SOURCE`, token copying or restart is required.
- Authentication, account confirmation, last successful sync and latest glucose
  timestamp are separate states. No readings is not reported as a successful
  glucose import. A revoked grant asks for reconnection; transient failures retry.
- Reconnection does not replace a working connection until the new account and
  credentials have been saved. Cancelling preserves the previous connection.
- Existing environment-driven connectors are unchanged until a native connection
  is saved. Replacing one requires confirmation. The native source then takes
  precedence, including after restart; old credentials are not silently resumed
  on Disconnect. A minimal disabled ownership record remains, without tokens or
  patient identity. External uploaders are outside this source-selection control.
- Multiple eligible patients require selection. A single account is preselected
  but still shown for confirmation. A follower never falls back to their own
  personal monitor data. Do not use one Nightscout history for different people.
- Existing manual CareLink token files/PR #54 token collections are not migrated
  in this WIP. Use the new sign-in once. Other connectors have not been migrated.

## Packaging and isolation

Both Docker build stages use Node 22/Debian Bookworm. Distribution Chromium,
Xvfb and fonts are installed at build time for amd64/arm64 availability. The
regular image includes them; non-CareLink users also download the larger image.
Actual architecture testing is listed below, not implied by package availability.

The init/supervisor starts Nightscout as UID 1000. On demand, it starts a
disposable browser worker as UID 1001 with a minimal environment. Neither the
worker nor Chromium inherits `API_SECRET`, MongoDB credentials or provider
tokens. `/opt/app`, including the JWT signing key, is inaccessible to that UID.
Chromium uses a private DevTools pipe, not an exposed TCP debugger. Frames/input
travel through bounded private IPC and authenticated same-origin HTTP endpoints.
Only the latest frame is retained. The worker, Xvfb and Chromium exit at the end
of a login; the temporary profile is deleted. Passwords and screenshots are not
logged or stored. Input necessarily passes through the Nightscout host.

The provided Compose file supplies the seccomp profile needed for Chromium's
user-namespace sandbox, `no-new-privileges`, a read-only root filesystem and
bounded temporary storage. Only SETUID/SETGID/KILL capabilities remain for the
small supervisor to launch and reap its children across UIDs. This is not a
privileged container, and `--no-sandbox` is never used.
An image cannot change a host's existing seccomp policy. On a host that blocks
unprivileged namespaces, login fails closed; use a compatible host/profile.
Running the image with a forced non-root UID leaves the ordinary app available
but disables the separate-UID browser broker. Direct `npm start` also leaves the
login browser unavailable; use the supplied container for this evaluation.

A validating HTTPS CONNECT proxy pins checked public IPv4 destinations and
allows only the Medtronic/login/challenge hosts listed in `browser/policy.js`.
Browser request interception, blocked downloads/popups, disabled QUIC and
non-proxied WebRTC restrictions provide additional protection. **This is not an
OS-enforced network namespace around the entire browser process** and is not
equivalent to a separately isolated hostile-code service. A compromised browser
main process could bypass browser-level proxy policy. Do not mount world-readable
secrets elsewhere in this container. Stronger whole-process filesystem/network
confinement and an independent security review remain release gates.

The browser shares the container's RAM limit with Nightscout. Admission checks
require 512 MiB of apparent headroom on cgroup v2; they cannot guarantee that an
OOM event will spare the app. The limit is one login per app instance, with a
10-minute absolute timeout, 3-minute input-idle timeout, and 45-second UI
disconnect grace. Login sessions are in memory, so a restart needs a fresh
login. Saved credentials survive restarts. Mongo leases serialize import/token
refresh mutations, but multi-replica display routing is not supported: test with
one Nightscout process/replica.

## Data and persistence

`lib/connect` owns auth, lifecycle, storage, output and the CareLink provider.
The login lifecycle uses XState 4, matching the existing connector dependency.
OAuth discovery maps the registered country to US/EU (Canada is not assumed US).
PKCE/state are generated server-side; only the exact custom redirect with one
matching state and one code is accepted, once. Provider errors are reduced to
safe status codes, never raw response bodies.

The private `auth_connect` collection (respecting the configured auth prefix)
uses the existing Mongo connection. AES-256-GCM encrypts connection records with
a purpose-specific HKDF key derived inside the enclave from the stable API
secret, not the per-build JWT key. Writes and token rotation are awaited.
An encryption-key change is surfaced rather than treating the record as absent.

Imports use Nightscout's storage adapters and sanitizer. Glucose records are
ordered, deduplicated and filtered for invalid timestamps/sensor-error values.
Explicit timestamp offsets are preserved; naive timestamps require the conduit
offset. The newest valid glucose is retained even when trend metadata disagrees.
Recognized meals, delivered FAST boluses and fingerstick markers are mapped;
unknown/extended bolus markers are not guessed. Pump/device fields are copied
only when present and valid. These mappings still require comparison against a
real account/device before any production use or dosing reliance.

## Validation and remaining release gates

Automated regression coverage includes callback/state validation, private API
authorization, cross-origin/owner isolation, session cancellation, refresh
rotation persistence, database failures, patient confirmation, output mapping,
real Mongo encryption/locking/deduplication and DOM-level owner controls.

```sh
npx env-cmd -f tests/ci.test.env mocha --timeout 15000 --exit 'tests/carelink-native*.test.js'
node scripts/carelink-container-smoke.js
node scripts/carelink-container-smoke.js --crash
```

The first command needs a dedicated localhost test MongoDB. The second is an
explicit live, account-free check against the unconfigured Compose instance: it
opens the public CareLink page, checks frame delivery, then cancels. It never
submits a username/password. It must not be run against a configured real site.
The third additionally kills the disposable worker in the named test container
and verifies that the failure is reported and no browser/profile is left behind.

Local validation on 22 September 2026 used Node 22, MongoDB 7 and Docker Desktop
on arm64, based on upstream `dev` commit `74fc6619`. The production image built
successfully (approximately 1.06 GB unpacked). Account-free container checks
reached the public Medtronic sign-in page, delivered its rendered frames and
verified cleanup after cancellation and a forced worker crash. The browser UID
could not read Nightscout's signing-key file or the supervisor's environment.
Client-core coverage passed 286 tests. amd64 and the full supported Node/MongoDB
matrix have not been validated here.

The final full sequential regression run passed **2,429 tests**, with three
pending tests, including the native CareLink unit, DOM and real-Mongo coverage.

The existing parallel unit command reproduced authentication-test timeouts on
unmodified `dev` as well as this branch. Use the full sequential regression
command for this local evaluation:

```sh
npx env-cmd -f tests/ci.test.env mocha --timeout 15000 --require tests/hooks.js --exit 'tests/*.test.js'
```

These are local results, not hosted CI results. No production service or real
CareLink account was used. The admin screen has component-level tests but still
needs hands-on visual testing.

Outstanding hands-on checks: full CareLink login/token exchange, MFA/CAPTCHA,
patient/device data parity, refresh with real rotated tokens, physical iOS and
Android typing/paste/composition, interrupted connectivity and prolonged memory
use. A screenshot stream is not a complete accessible page: keyboard navigation
and focused-field labels are present, but screen-reader and accessible challenge
flows need separate validation. Device-bound passkeys and password-manager
autofill are not promised. This is why the branch is WIP and no PR is open.

## Attribution

OAuth discovery and PKCE protocol work builds on LeFrenchGuy's
[nightscout-connect PR #54](https://github.com/nightscout/nightscout-connect/pull/54)
and [carelink-bridge](https://github.com/nightscout/carelink-bridge).
Provider endpoints and data mappings build on Nightscout contributors' existing
`nightscout-connect` and `minimed-connect-to-nightscout` drivers. The ephemeral
remote-browser approach and seccomp profile were informed by the existing
Nightscout Pro implementation. This implementation does not copy Pro credentials
or its browser/egress service deployment.
