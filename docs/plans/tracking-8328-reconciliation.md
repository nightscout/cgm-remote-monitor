# Modernization tracker reconciliation

Snapshot: modernization integration `37155778`, 2026-09-06. GitHub still reports
[#8328](https://github.com/nightscout/cgm-remote-monitor/issues/8328) open. This is
a requirement/evidence mapping, not an issue closure or release approval.
#8605 remains the draft integration PR to dev; child merges are not evidence
that modernization has shipped.

| Requirement in #8328 | Verified integration evidence | Remaining work |
| --- | --- | --- |
| Node 22 compatibility and default CI/images | The issue already checks this item. Docker defaults to Node 22; CI uses floating 22/24. The supported patch floors are documented and enforced. | Final release-candidate execution on admitted minimum patches and hosting/upgrade gates. Do not substitute version-string tests for execution. |
| Audit relevant npm security issues; update or replace dependencies | M01–M09 and subsequent dependency slices contain scoped consumer, exploit/API, install and CI evidence. #8686/#8687 update lint tooling and establish the CLI gate; #8688 removes alarm credentials from logs; #8689 refreshes the development sanitizer comparator. | M09 is ongoing. Re-run production/full audits on the final graph, review remaining packages/overrides and distinguish reachability from advisory counts. |
| Update/migrate Moment | The retained dependency and its profile/API contracts remain present. M27 tracks the existing spring-DST schedule discrepancy and historical/browser-data limits. | #8690 reviews native Intl/Luxon; #8691 proposes refreshed timezone data. Both were open at this snapshot. Neither completes parsing, therapy/report/locale/browser equivalence or the final retain/narrow/replace decision. |
| Update/migrate D3 | The lock resolves D3 7.9.0. #8633 narrows the shared browser surface and records chart/report contracts and measured transfer reduction. | Preserve custom-script migration guidance and final UI/accessibility release validation. No additional D3 replacement is established as necessary by #8328 itself. |
| Update/migrate benv | benv and jsdom are absent from the package graph; the retired DOM harness was replaced with real-browser contract tests. #8629 records the completed jsdom retirement and its test-installation cost. | Keep browser tests in CI and finish physical-device gates; do not claim server-memory savings from removing an already development-only harness. |

#8328 references [#8207](https://github.com/nightscout/cgm-remote-monitor/issues/8207),
whose original request was migration away from Node 16 toward Node 20. The agreed
modernization policy supersedes that old target with Node 22/24 support; it does
not require restoring Node 20 support. Later discussion of a separate rewrite
is not, by itself, an accepted requirement to replace this repository's UI.

## Corrected implementation status

- M10 build/runtime separation merged in #8657. Final image/build-time figures
  and live hosting validation remain open; the implementation is not still a proposal.
- M22 explicit proxy trust merged in #8680. Deployment-specific trust settings
  and final hosting migration checks remain open.
- M24's native-watch comparison/retain decision merged in #8670. Nodemon stays;
  the native environment runner already replaced env-cmd.
- M28 selected maintained jQuery UI modules merged in #8674 and native help
  tooltips merged in #8668. Dialog/food/HMR/cached-navigation coverage is present.
  Native-dialog/Flot/jQuery decisions and physical iPhone Safari/VoiceOver remain open.
- M29 local Dexcom and MiniMed retirements merged in #8678/#8682. MongoDB 4.4
  retirement, driver/maintained-version and replica CI work is integrated.
  Live vendor/hosting migration, database backup/restore/upgrade/rollback evidence
  and other documented release gates still prevent treating M29 as complete.

The unchecked items remain M09, M10, M22, M25, M27, M28, M29 and M30. M25 still
needs a final notification-cache bound/clone policy and retain/replace decision.
M30 still needs consolidated before/after package, image, server and browser
measurements against a stated baseline. Per-slice savings must not be summed into
an unsupported typical-instance RAM claim.

Do not close #8328 or mark #8605 ready merely because benv/D3 work is integrated.
The remaining dependency decisions, final validation and measurements must be
resolved and reconciled with the full M01–M30 plan first.
