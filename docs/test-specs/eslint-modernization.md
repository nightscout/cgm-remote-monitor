# Maintained ESLint and development lint integration (M09 partial)

Upgrade ESLint 7.32.0 to 10.10.0 and eslint-plugin-security 1.7.1 to 4.0.1.
The registry releases were checked on 2026-09-06. Add the maintained recommended
rules/configuration data packages @eslint/js 10.0.1 and globals 17.12.0 instead
of copying upstream rule/global lists into the repository. All engine ranges
accept Nightscout's Node 22.23.2 and 24.20.0 floors.

ESLint 10 requires flat configuration and the current asynchronous API. Replace
.eslintrc.js with eslint.config.cjs; preserve the existing environments,
ECMAScript 2020 module parsing for .js, security object-injection exception and
unused-variable name pattern. Explicitly retain the prior constant-condition
loop check because the new default exempts while(true). Use the maintained
recommended rules, including their additional diagnostics. References:
[ESLint 10 migration](https://eslint.org/docs/latest/use/migrate-to-10.0.0) and
[flat configuration migration](https://eslint.org/docs/latest/use/configure/migration-guide).

## Remove the webpack wrapper

The existing development policy displays lint diagnostics without blocking
compilation or HMR. eslint-webpack-plugin 6 still places lint errors in
compilation.errors with failOnError:false, unlike the old integration. Its
initial candidate blocked the actual page HMR fixture.

Replace eslint-webpack-plugin with webpack/lint-plugin.js using ESLint's public
API and webpack's compilation hooks. It collects project JavaScript modules,
excludes node_modules and paths outside the project, includes unchanged modules
on rebuilds, and emits formatted diagnostics as compilation warnings. The CLI
continues to report original rule severities. Configuration/engine failures
and ordinary webpack syntax failures remain fatal. Physical project-root
normalization handles symlinked paths, including macOS temporary directories.
No generic wrapper option surface, worker pool, timer or extra cache is added.

## Diagnostic comparison and remaining cleanup

The [same-source CLI comparison](../audits/eslint-diagnostics-comparison.json)
retains every baseline finding. ESLint 7 reports five errors and sixteen warnings
across 226 files. ESLint 10 reports 53 errors and 47 warnings across 227 files:
21 additional unused catch bindings, 27 unused assignments, and 31 unused-disable
warnings. The CLI now also includes lib/d3.mjs. Existing security warnings remain.
`npm run lint` exits nonzero before and after this change; it is not currently a
required whole-repository CI gate. These findings are not hidden by disabling
new rules or altering runtime code in this toolchain PR.

Review the assignment/catch findings in separate behavior-preserving cleanup
changes, retaining relevant therapy/report/storage regressions. Review security
warnings by actual reachability before adding scoped suppressions. Establish a
clean error baseline before adding whole-repository lint as a required CI gate.
Targeted configuration and integration regression tests remain part of CI now.

## Validation and cost

- A clean Node 22 installation/production build passes; npm audit reports zero
  known vulnerabilities at validation time.
- All 267 dependency cases pass on both Node 22 and Node 24. Tests cover configuration loading,
  globals, undefined names, unused variables, security warnings and formatting.
- The local lint integration test performs repeated builds, confirms diagnostics
  are fresh and non-blocking, retains fatal syntax failures, and clears stale
  warnings after a clean build.
- Actual Node 24 Chromium page HMR passes repeated updates and two compile-error
  recovery cycles, preserving unsaved input and page exports.
- Nine Node 22 WebKit HMR/asset/cascade checks pass. Full local Node 22/MongoDB 6
  backend coverage passes 1,922 tests with one existing pending case. Full
  current-head hosted CI remains required before integration.

ESLint no longer consumes YAML configuration or the table formatter. Remove
those obsolete consumer tests; retain js-yaml 3 coverage through NYC and js-yaml
4 coverage through Mocha, and retain Ajv/fast-uri tests for installed consumers.

The [matched file/bundle comparison](../audits/eslint-toolchain-comparison.json)
shows **41 fewer package paths and 3,596,213 fewer installed file bytes**. Two
configuration-data declarations replace one wrapper declaration, so direct
declarations increase by one. Every production dependency record is unchanged,
and all six production JavaScript bundles are byte-identical. These are
build/developer installation savings, not server heap/RSS or image measurements.

Rollback the manifest, lockfile, configuration, webpack integration and consumer
tests together. The older toolchain's nonzero CLI findings still require cleanup;
reverting this PR does not establish a clean lint baseline.
