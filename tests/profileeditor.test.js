'use strict';

// Phase 5b retired the bundle-driven Profile editor test in favor of
// Node-only unit tests against the pure modules under
// lib/client-core/profile-editor/. The original DOM-driven assertions
// (counting #pe_databaserecords / #pe_profiles option lengths after
// add/remove/clone clicks, and toggling I:C / target-bg ranges) are
// now covered by:
//
//   tests/profileeditor.records.test.js          — DOM-equivalent CRUD
//   tests/client-core/profile-editor-records.test.js
//   tests/client-core/profile-editor-profiles.test.js
//   tests/client-core/profile-editor-ranges.test.js
//   tests/client-core/profile-editor-migrate.test.js
//   tests/client-core/profile-editor-defaults-and-time.test.js
//
// Manual end-to-end UI verification is documented in
// docs/test-specs/manual-smoke-checklist.md.
//
// This shim is kept (instead of deleted) so anyone searching for the
// original test name lands here. The previous it.skip placeholder is
// gone — see docs/proposals/track1/phase1c-shim-parity.txt for the
// history of why the bundle test was retired.

require('should');
var fs = require('fs');
var path = require('path');

describe('Profile editor (legacy DOM test retired)', function () {
  it('coverage migrated to lib/client-core/profile-editor + tests/profileeditor.records.test.js', function () {
    fs.existsSync(path.join(__dirname, 'profileeditor.records.test.js'))
      .should.be.true();
  });
});
