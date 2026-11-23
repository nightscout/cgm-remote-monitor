'use strict';

/*
 * benv-loader.js
 *
 * Phase 4: the `benv` package has been removed. This loader now
 * unconditionally returns the modern jsdom shim, which exposes the
 * same `setup`/`expose`/`require`/`teardown` API that legacy tests
 * (careportal, profileeditor, reports) still consume via headless.js.
 *
 * The loader survives as a single chokepoint so the remaining legacy
 * tests can be migrated to require `./benv-shim` (or its successor)
 * directly without coordinating a multi-file change. Once those tests
 * are modernized this file should be deleted.
 */

module.exports = require('./benv-shim');
