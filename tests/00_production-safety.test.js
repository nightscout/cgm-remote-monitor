'use strict';

/**
 * Production Safety Check - Database Level
 * 
 * GAP-SYNC-047: This test runs FIRST (00_ prefix) to verify
 * the database is safe for destructive test operations.
 * 
 * Checks:
 * 1. Database name contains "test"
 * 2. Entry count is below threshold (default: 100)
 * 
 * Environment Variables:
 * - TEST_SAFETY_MAX_ENTRIES: Max entries before refusing (default: 100)
 * - TEST_SAFETY_REQUIRE_TEST_DB: Require "test" in DB name (default: true)
 * - TEST_SAFETY_SKIP: Bypass all checks (dangerous!)
 */

var should = require('should');
var language = require('../lib/language')();
var productionSafety = require('./lib/production-safety');

describe('00 Production Safety Check', function() {
  this.timeout(10000);
  var self = this;

  before(function(done) {
    // Boot the app to get DB connection
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];

    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      done();
    });
  });

  it('should verify database is safe for destructive tests', function(done) {
    // This is the critical safety gate
    productionSafety.checkProductionSafety(self.ctx, self.env)
      .then(function() {
        done();
      })
      .catch(function(err) {
        // Fail the test suite immediately
        console.error('\n\n' + '!'.repeat(70));
        console.error('TEST SUITE HALTED - Production safety check activated');
        console.error('!'.repeat(70) + '\n');
        process.exit(1);
      });
  });

  it('should have extracted correct database name', function() {
    var dbName = productionSafety.extractDbName(self.env.storageURI || self.env.mongo_connection || '');
    dbName.should.be.a.String();
    dbName.length.should.be.greaterThan(0);
    console.log('[SAFETY] Database name: ' + dbName);
  });
});
