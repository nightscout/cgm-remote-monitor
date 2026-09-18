# Refresh modernization against dev (2026-09-06)

Merge dev `ca35f2a3` into modernization `8a07bfb6`, preserving the merged fixes
for treatment query failures (#8697), low/falling clock readings (#8699),
embedded profile-switch schedules (#8701), unnamed profiles (#8702), and
translation/Alexa updates (#8603). This refresh does not resume M09 dependency
work or promote the draft integration PR #8605.

The textual conflict is a modify/delete conflict in the old clock test: dev adds
low/trending assertions to a test modernization replaced with real-browser
coverage. Keep the legacy test deleted and port all sixteen new cases to the
existing production clock-bundle suite. Each scenario repeats the HTTP/render
cycle, including missing/alias directions, target boundaries, stale readings,
low-value precedence and mmol display.

Dev also adds six unnamed-profile editor cases using the retired jsdom harness.
Move all six to the real-browser suite with the production profile form and
app/profile/report bundles. Use actual fixture HTTP GET/PUT requests, verify
unchanged saves twice, explicit rename collisions, named-to-blank protection,
profile report retention and recovery from a dangling default pointer. The
private test module bundle exposes profilefunctions for this fixture only.
No jsdom, benv or replacement DOM implementation is restored.

The standalone treatment API test configures the same mutable query/parser
middleware used by the application's Express 5 entry points. Its error responses,
subsequent valid requests, timezone offsets and cached conditional responses
remain covered. Production changes from dev otherwise merge automatically.

Focused validation passes 51 backend/translation/Alexa cases on Node 22.23.2
and 24.20.0, 283 client-core cases, and 27 Chromium clock/profile cases.
Changed-source lint has no errors. The full Node 22 backend suite passes 2,058
cases with one existing pending case; all 574 Chromium browser cases pass.
Hosted final-head CI remains required for the refreshed integration.
