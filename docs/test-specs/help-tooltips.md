# Native help tooltip candidate (M28)

Replace the two jquery.tooltips initializers with one delegated document helper.
Chart/pill tooltips and jQuery UI dialogs stay separate. The legacy tooltip CSS
is retained because other .tooltip elements share it. The new help stylesheet
is loaded by the main page and included in service-worker precaching.

The helper shows escaped text from the current translated original-title/title,
adds a role=tooltip description when the name does not already contain that text,
restores existing aria-describedby values on
hide, supports keyboard focus/Space/Enter/Escape and makes drawer help anchors
focusable. Pointer hover can move onto the tooltip. Touch drawer tips open on
tap and dismiss on another help tap, the tooltip itself or an outside tap;
toolbar touch activation is not intercepted. Repeated initialization installs
one tooltip/listener set. Resize hides it; scrolling repositions keyboard-focused help and dismisses hover-only help; narrow-screen placement clamps
horizontally and flips above a low trigger. It has no fade animation or arrow.

Nine isolated real-browser cases pass in Chromium on Node 22 and WebKit on Node
24: repeated focus/Escape, translated text escaping and hover transfer, touch
open/dismiss and toolbar activation, keyboard help names, narrow bounds and
resize, repeated initialization/destruction with description restoration, pointer-independent click dismissal and native focus scrolling.
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

Integration requires full current-head hosted CI and current-base merge verification;
these isolated tests alone are insufficient. Final physical-device/spoken-output
validation is a release gate on #8605 before merging into dev; see
[the iPhone Safari/VoiceOver checklist](iphone-voiceover.md). The rest of M28's
widget/chart review also remains open. Do not mark M28 complete.
Rollback restores the manifest/lock import and old initialization together,
then removes the native helper/style and its main-page/service-worker entries.

## Application-page follow-up

Four additional cases load the production EJS template, real styles and compiled
app bundle, with finite owned HTTP/Socket.IO fixtures. Each opens and dismisses
French drawer help twice in mg/dL and mmol/L, using keyboard and touch, and
checks translated accessible names and tooltip placement beside the trigger.
All twelve component/application cases pass in Chromium/Node 22 and WebKit/Node 24.
The updated application screenshot was inspected. This covers real page
composition, not a live deployment or a screen reader's spoken output.

The first screenshot exposed a placement defect when switching from a short
toolbar label to longer drawer help: measuring at the previous horizontal
position constrained wrapping. The new spacing assertion failed in both
keyboard unit cases (over 50px gap). Resetting the measurement position before
placement fixes it; the assertion now passes. The size comparison is refreshed
with hashes of the changed production sources. Hosted validation and final
screen-reader/target-device checks remain open.

## Hosted WebKit and fixture follow-up

Head 3dce1933 failed five Linux WebKit cases on each Node floor: tooltip-tap
dismissal and application-page focus/visibility. Local macOS WebKit had passed.
The candidate now dismisses clicks on the tooltip regardless of reported pointer
type and repositions focused help when native focus scrolls its trigger into view.
Two targeted regressions run in addition to the original assertions. Chromium
with the prior helper fails the native focus-scroll regression; pointer-independent
click dismissal passes there and therefore does not reproduce the hosted
touch-dismissal failure locally. All twelve cases pass locally on Chromium/Node 22 and
WebKit/Node 24 after the changes. Hosted validation is still required.

The two CodeQL alerts were in the owned application fixture's regex removal of
script tags. The fixture now uses native DOMParser, removes script nodes and
serves the serialized template before loading the compiled application manually.
No production sanitization or CodeQL rule is disabled. Fresh CodeQL must confirm
the result. Production-build measurements and source hashes are refreshed.

## Direct tooltip click follow-up

Hosted head db3c6970 passes the keyboard cases and CodeQL, but both WebKit jobs
still fail the three tooltip-tap dismissal cases. A direct click listener on the
tooltip is now installed and removed with the document controller. This tests
the hypothesis that WebKit's touch-to-click handling of non-interactive elements
is bypassing document delegation. See the historical
[WebKit event-delegation report](https://bugs.webkit.org/show_bug.cgi?id=171105);
it is supporting context, not proof of this current failure's cause. Bounded
pointer/touch/click/focus traces are attached to failed dismissal assertions.
The original visibility assertions remain unchanged. Hosted confirmation is
required; local macOS WebKit cannot establish Linux WebKit behavior.

## Computed accessible-name/description follow-up

The application accessibility-tree probe found the same French help sentence in
both the button name and its description. The helper now omits the duplicate
tooltip association when aria-label already contains the full help text, while
retaining unrelated pre-existing descriptions. Toolbar tips whose label differs
from the help text still receive the description. Visible content and interactions
are unchanged.

A new repeated-focus regression fails the previous helper: it adds
`ns-help-tooltip` to an existing description despite already exposing that text
as the name. The application cases now inspect Chromium's computed accessibility
tree over both units and keyboard/touch cycles: the translated button name remains,
it is not ignored, and there is no duplicate description. WebKit retains the
attribute/content/interaction assertions. This is browser accessibility evidence,
not a claim about every screen reader's speech or real target devices.

The candidate incorporates driver integration cbbd4581 without conflicts and
passes a clean Node 22 install/build. Fresh hosted validation remains required.

## Integration refresh

The candidate incorporates integration 28f4ea4a. A clean Node 22 install/build
and all 21 focused tooltip/admin cases pass in Chromium/Node 22 and WebKit/Node 24.
The widget inventory now tolerates removed packages and recognizes selective
jquery-ui imports. Fresh hosted CI is required for the resulting head.
