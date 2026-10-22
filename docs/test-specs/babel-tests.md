# Babel build regression tests

The build uses Babel core/preset-env 7.29.7 and babel-loader 9.2.1. These are
compatible Babel 7 releases. Runtime policy now requires Node 22.23.2+ or 24.20.0+; the Babel 8 migration remains a separate change:
Babel 8 requires Node 22.18+ or 24.11+, while loader 10 excludes Node 20 releases
before 20.10. A future upgrade to those major versions needs an explicit runtime
support decision. The project's `.babelrc` and `.browserslistrc` are unchanged.

`tests/dependency-babel.test.js` runs under both `npm run test-ci` and
`npm run test:dependencies`. CI also validates the installed Babel/loader tree.

The suite covers:

- Compiler/preset/loader peer compatibility and Node major-line minimums.
- Transpiled lexical `this`, optional chaining/nullish zero, object-rest getter
  evaluation, private fields and async-generator cleanup, with an explicit
  older Safari syntax target. This checks transforms, not runtime polyfills.
- Rejecting invalid `new super()` syntax before it reaches a bundle.
- Development and minified production builds using the repository's actual
  Babel loader rule, including real duration and glucose-unit calculations.
- Source-map source/content retention, stable cached builds and invalidation
  after two successive source edits.

Full application production builds run during installation in the Node/MongoDB
matrix. The npm 12 job also builds the development bundle with ESLint integration.
When changing the compiler again, compare production bundles and source maps
against dev; if output changes, exercise affected charts/forms in a browser.

No user configuration or visual changes are required for this update.

References: [Babel 7.29.7](https://github.com/babel/babel/releases/tag/v7.29.7),
[Babel 8 migration](https://babeljs.io/docs/v8-migration),
[loader 9.2.1](https://github.com/babel/babel-loader/releases/tag/v9.2.1),
[loader 10 requirements](https://github.com/babel/babel-loader/releases/tag/v10.0.0).
