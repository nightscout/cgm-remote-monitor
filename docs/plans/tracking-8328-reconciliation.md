# Modernization tracker reconciliation

The M01–M30 implementation and automated validation work is being completed on
`chore/nightscout-modernization`, with #8605 remaining the draft integration PR
to dev. Child merges are integration work, not a release. The maintainer owns
production, vendor-account/Atlas IAM and physical-device validation afterward.
See the [final evidence](../test-specs/modernization-completion.md).

| Requirement in #8328 | Integration disposition |
| --- | --- |
| Node 22 compatibility/default CI and images | Node 22 is the image default; actual Node 22.23.2 and 24.20.0 execute local final validation. Floating 22/24 CI covers MongoDB 5/6/7/8, with replica failover, npm 12 and native amd64/arm64 Docker. |
| Audit relevant npm security issues | M09 reviews direct and transitive dependencies with consumer regressions. The final full and production npm audits report zero advisories; this is not proof that all possible vulnerabilities are absent. |
| Update/migrate Moment | #8716 completes M27: retain narrowed Moment 2.30.1 and timezone 0.6.3/IANA 2026c for 15.0.9. Compared alternatives do not justify changing therapy/date contracts and retained browser support. Existing historical/DST limits and a dated review trigger are explicit. |
| Update/migrate D3 | D3 7.9.0 is integrated and its shared exports narrowed in #8633. M28 retains the existing chart architecture, updates Flot to 4.2.6 and characterizes plotted data/axes/labels. A partial pie port did not remove Flot or justify a second implementation. |
| Update/migrate benv | benv/jsdom are absent from the graph. Required Chromium, Firefox and WebKit tests preserve the browser contracts; pure client-core cases run separately. |

#8328 references #8207's older Node 16-to-20 direction. The accepted Node 22/24
policy supersedes that target. A framework/TypeScript rewrite, further MongoDB
5/6 retirement, and replacement of every retained library are not implicit
requirements of this dependency plan.

M10 build/runtime separation, M22 proxy compatibility with optional explicit trust, M25 maintained cache,
M27 date/time and M28 widget retain/migrate decisions are explicit. M29 includes
legacy Dexcom/MiniMed migration mappings, the reviewed Connect pin (upstream
#66, stacked on #64 which includes merged #65), and owned database upgrade and
backup-recovery evidence. Additional architecture ideas in older proposals stay
separate from the accepted modernization scope.

Keep #8328 open through the maintainer's handoff and #8605 integration. Its
checklist may describe completed branch work, but must not imply the release has
shipped or that physical clients/hosting have passed. Normal maintenance should
repeat dependency audits and revisit the dated compatibility decisions.
