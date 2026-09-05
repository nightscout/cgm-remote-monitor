# Native webpack assets and CSS (M11)

The candidate replaces file-loader with `asset/resource` and the css-loader/style-loader pair with webpack's native global CSS modules, using `experiments.css: true` and `parser.exportType: style`. No replacement package or webpack version upgrade is introduced. Native CSS remains an experimental webpack API, so upgrades must retain these checks rather than assuming loader parity.

## Behavior and regression coverage

The old style-loader 0.23.1 expects a CommonJS CSS array; css-loader 5 supplies an ES module namespace. The unchanged integration parent's production bundle injects no styles into an isolated document. Templates also load static CSS, masking that broken injection. The new runtime injects the same global stylesheet declarations and applies updates in place. Existing template links remain intact.

`tests/browser/assets.test.js` adds seven required browser cases:

- The actual production bundle supplies the toolbar background image at `/bundle/images/7342f65db5b9bb9b02700ef08b4ef27c.png`. The browser decodes it and verifies source PNG dimensions. All three original CSS files remain exact `sourcesContent` entries in the production JavaScript source map.
- Each of the five main templates (index, administration, profile, food and reports) retains the computed layout/text/border/interaction properties of every element with an ID at widths 390 and 1280, before and after bundle execution. The fixture uses the rendered production body, original stylesheet order and inline styles. Only scripts, audio, image elements and three external font imports are omitted. This checks the static cascade, not full application initialization; existing chart, report, care portal and editor suites cover interactions.
- A persistent compiler uses the real development rules, plugins, source maps and public path, with owned temporary source/output/records files. The real browser HMR runtime applies two changed CSS builds without reloading or losing page state, preserving `/devbundle/` image URLs. This exercises update manifests/chunks and CSS replacement, not the middleware EventSource transport. The actual full application HMR build is a separate gate.

Run after `npm ci` and explicit browser installation:

```sh
npx --no-install mocha --timeout 30000 --require ./tests/browser/hooks.js tests/browser/assets.test.js
NIGHTSCOUT_TEST_BROWSER=webkit npx --no-install mocha --timeout 30000 --require ./tests/browser/hooks.js tests/browser/assets.test.js
npm run test:browser
npm run test:core
npm run test:dependencies
npm run test-ci
```

CI requires all browser engines on both Node floors, the Node/MongoDB matrix, npm 12, CodeQL and both native Docker architectures. The surviving PostCSS compatibility test now checks sanitize-html, its remaining consumer; its parser, sanitizer and source-map safety assertions remain.

## Measured candidate costs

Against integration `ce806e5b`, a clean installation removes 22 package paths (1,000 to 978) and 1,128,073 regular-file bytes, excluding caches, symlinks and the hidden installed lockfile. No retained package version changes. Production paths fall from 672 to 649: 22 paths disappear and ajv-keywords becomes development-only.

The production app bundle falls from 1,761,400 to 1,742,421 bytes (18,979 bytes smaller). The clock bundle remains byte-identical at 152,131 bytes. Logo bytes and the 32-character filename remain identical. `output.hashDigestLength: 32` preserves that filename and also lengthens opaque HMR hashes; repeated runtime update checks cover their use. No server heap or Docker image size saving has been measured for this slice.

Rollback restores manifests, lockfile and webpack rules together. Restore the css-loader consumer assertion only with that dependency. The new CSS-injection/HMR assertions intentionally expose the former loader defect, so a rollback also needs an explicit decision about that behavior. Do not disable application interaction coverage.
