# Native help tooltip candidate (M28)

Replace the two jquery.tooltips initializers with one delegated document helper.
Chart/pill tooltips and jQuery UI dialogs stay separate. The legacy tooltip CSS
is retained because other .tooltip elements share it. The new help stylesheet
is loaded by the main page and included in service-worker precaching.

The helper shows escaped text from the current translated original-title/title,
adds a role=tooltip description, restores existing aria-describedby values on
hide, supports keyboard focus/Space/Enter/Escape and makes drawer help anchors
focusable. Pointer hover can move onto the tooltip. Touch drawer tips open on
tap and dismiss on another help tap, the tooltip itself or an outside tap;
toolbar touch activation is not intercepted. Repeated initialization installs
one tooltip/listener set. Resize/scroll hides it; narrow-screen placement clamps
horizontally and flips above a low trigger. It has no fade animation or arrow.

Six isolated real-browser cases pass in Chromium on Node 22 and WebKit on Node
24: repeated focus/Escape, translated text escaping and hover transfer, touch
open/dismiss and toolbar activation, keyboard help names, narrow bounds and
resize, repeated initialization/destruction with description restoration.
A narrow-screen screenshot was inspected. This does not establish live screen
reader output or complete app-page visual parity. Full application browser and
backend/hosted gates remain required; Firefox is validated in hosted CI.

The lock removes exactly jquery.tooltips with no added or changed retained
package records. The matched production-build comparison is in
../audits/help-tooltip-comparison.json. JavaScript gzip is essentially flat and
a small stylesheet is added; this is not a transfer-size or server-memory win.
The benefit is removing the plugin and adding explicit interaction/accessibility
behavior. The inventory examined 297 translated values for existing title keys;
none contained HTML markup/entity candidates. HTML inside future titles is
shown as text intentionally, not interpreted.

Remaining review: full app/drawer use with real styles and translated content,
Firefox, screen-reader QA, target touch devices, and the rest of M28's widget/
chart inventory. Do not mark M28 complete or merge from these isolated tests.
Rollback restores the manifest/lock import and old initialization together,
then removes the native helper/style and its main-page/service-worker entries.
