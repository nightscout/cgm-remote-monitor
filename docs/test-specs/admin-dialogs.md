# Authorization editor dialog regression coverage (M28)

The role and subject editors previously closed after a failed POST or PUT because
their dialog callbacks ignored the save error; the subject save helper also
removed the error before invoking its callback. Both editors now retain the
visible draft after a failed write so the user can correct or retry it.

A successful write remains successful if the subsequent list reload fails.
The existing list status reports that read failure and the editor closes. This
separation avoids presenting a committed new-record draft as an unsaved retry.
It does not make arbitrary server failures or network interruptions idempotent.

`tests/browser/admin-dialogs.test.js` loads the actual production app/admin
bundles and dark jQuery UI theme against an owned loopback HTTP fixture. It uses
actual jQuery UI dialogs and Ajax; only the backend responses/client setup are
fixture-controlled. No production server, authorization account or database is
modified. The eight cases cover both editors:

- Two create/edit cycles with Cancel and Escape, focus restoration, French Save
  and Cancel labels, exact normalized POST/PUT payloads, stable identifiers,
  notes, visible pending saves, refreshed lists and one dialog wrapper.
- Two failed POST cycles and two failed PUT cycles, preserving field contents
  through the alert and retrying the same payload with one request per click.
- Two successful-write/failed-list-refresh cycles, keeping the list error visible
  while closing the committed draft without an automatic duplicate write.

Before the fix, the two initial failed-POST cases fail at the visible-draft
assertion for both editors, while the successful/cancel cases pass. The additional
PUT and failed-refresh cases extend that causal regression boundary.

Run after a clean installation/build:

```sh
NIGHTSCOUT_TEST_BROWSER=chromium node node_modules/mocha/bin/mocha.js --timeout 30000 --require ./tests/browser/hooks.js tests/browser/admin-dialogs.test.js tests/browser/admin-actions.test.js
```

Use `webkit` and `firefox` for the other required CI browsers. This slice does not
complete all five application dialogs or the food drag/drop work in M28. Full
screen-reader output, touch-device behavior, light-theme comparison, resizable/
draggable defaults and the eventual native or maintained-module migration still
need their own evidence. No dependency or server-memory reduction is claimed.

Local validation on the candidate: clean Node 22.23.2 installation and production
build passed; the eight new dialog cases plus 13 existing admin-action cases pass
on Chromium/Node 22.23.2 and WebKit/Node 24.20.0 (21 each). The required hosted
matrix, including Firefox, must pass before integration.
