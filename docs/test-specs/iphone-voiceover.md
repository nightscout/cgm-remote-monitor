# iPhone Safari with VoiceOver release validation

Status: **not performed**. This is an open M28/#8605 release gate before the
combined modernization branch merges into dev. It does not require holding
individually reviewed implementation PRs outside the integration branch once
their code review, full CI and current-base verification pass.

Use a physical iPhone running Safari with VoiceOver enabled against the final
integration build, with owned non-production records. Record the commit,
iPhone model, iOS/Safari version, language, units and tester/date. Repeat with
mg/dL and mmol/L, and include translated help and both light/dark themes.
Automated Chromium accessibility-tree assertions and WebKit touch checks do
not establish spoken output on this device.

- Navigate the drawer using VoiceOver swipe navigation. Help controls must have
  meaningful translated names. Activate each representative help control twice;
  check that its text is available without confusing duplicate announcements,
  remains within the viewport and can be dismissed by touch without trapping
  navigation. Check toolbar actions still activate normally.
- Open and dismiss authentication, roles, subjects, treatment-edit and bolus-food
  dialogs twice. Verify spoken dialog/control names, initial focus, traversal,
  dismissal and focus return. Cancel must preserve saved records; failed saves
  must retain the draft with an understandable error and permit retry.
- In the bolus food picker, verify portions and carbohydrate totals are announced
  with their labels and units; cancel adds nothing and repeated additions keep
  independent portions. Check quick-pick editing and ordering for accessibility;
  record any operation that depends solely on dragging as an unresolved finding.
- Check portrait/landscape, scrolling and text enlargement for obscured controls,
  clipped help, lost focus or unreachable dismissal. Verify charts and treatment
  controls remain usable and record any pre-existing limitations separately.

Record each result with steps, expected/observed speech and any screenshot or
recording (without real patient data). Do not tick this gate based on desktop
Safari, emulation or a passing browser test. Failures need fixes and a repeat
check on the resulting integration commit; this checklist is not evidence of a
pass or a claim of full accessibility compliance.
