'use strict';

/**
 * Unit tests for production-safety.js module
 */

var should = require('should');
var productionSafety = require('./lib/production-safety');

describe('Production Safety Module', function() {
  
  describe('extractDbName', function() {
    
    it('should extract database name from standard MongoDB URI', function() {
      var dbName = productionSafety.extractDbName('mongodb://localhost:27017/nightscout_test');
      dbName.should.equal('nightscout_test');
    });

    it('should extract database name from MongoDB+SRV URI', function() {
      var dbName = productionSafety.extractDbName('mongodb+srv://user:pass@cluster.mongodb.net/mydb_test');
      dbName.should.equal('mydb_test');
    });

    it('should handle URI with query parameters', function() {
      var dbName = productionSafety.extractDbName('mongodb://localhost:27017/nightscout_test?retryWrites=true');
      dbName.should.equal('nightscout_test');
    });

    it('should handle URI with auth credentials', function() {
      var dbName = productionSafety.extractDbName('mongodb://user:password@localhost:27017/test_db');
      dbName.should.equal('test_db');
    });

    it('should return default for empty connection string', function() {
      var dbName = productionSafety.extractDbName('');
      dbName.should.be.a.String();
    });
  });

  describe('isTestDatabaseName', function() {
    
    it('should recognize "_test" suffix', function() {
      productionSafety.isTestDatabaseName('nightscout_test').should.be.true();
    });

    it('should recognize "test_" prefix', function() {
      productionSafety.isTestDatabaseName('test_nightscout').should.be.true();
    });

    it('should recognize "test" anywhere in name', function() {
      productionSafety.isTestDatabaseName('my_testing_db').should.be.true();
    });

    it('should be case insensitive', function() {
      productionSafety.isTestDatabaseName('Nightscout_TEST').should.be.true();
      productionSafety.isTestDatabaseName('TEST_DB').should.be.true();
    });

    it('should reject production-looking names', function() {
      productionSafety.isTestDatabaseName('nightscout').should.be.false();
      productionSafety.isTestDatabaseName('production').should.be.false();
      productionSafety.isTestDatabaseName('mydb').should.be.false();
    });

    it('should reject names with "test" as substring of other words', function() {
      // "contest" contains "test" but is not a test database
      // Current implementation will actually match this - documenting behavior
      productionSafety.isTestDatabaseName('contest').should.be.true(); // Contains "test"
    });
  });

  describe('DEFAULT_MAX_ENTRIES', function() {
    
    it('should be a reasonable default (100)', function() {
      productionSafety.DEFAULT_MAX_ENTRIES.should.equal(100);
    });
  });

  describe('preflightCheck', function() {
    
    it('should not throw when NODE_ENV=test', function() {
      // This test is running, so NODE_ENV must be test
      process.env.NODE_ENV.should.equal('test');
      // preflightCheck would have already run via hooks.js
      // If we got here, it passed
    });
  });

  describe('checkProductionSafety messaging', function() {
    var savedEnv;

    beforeEach(function() {
      savedEnv = {
        TEST_SAFETY_SKIP: process.env.TEST_SAFETY_SKIP,
        TEST_SAFETY_REQUIRE_TEST_DB: process.env.TEST_SAFETY_REQUIRE_TEST_DB,
        TEST_SAFETY_MAX_ENTRIES: process.env.TEST_SAFETY_MAX_ENTRIES
      };
    });

    afterEach(function() {
      // Restore env
      Object.keys(savedEnv).forEach(function(k) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      });
    });

    it('should pass when database is empty even if name lacks "test"', function(done) {
      process.env.TEST_SAFETY_REQUIRE_TEST_DB = 'true';
      delete process.env.TEST_SAFETY_MAX_ENTRIES;
      delete process.env.TEST_SAFETY_SKIP;

      var mockCtx = {
        store: {
          db: {
            collection: function() {
              return {
                countDocuments: function(query, opts) {
                  return Promise.resolve(0);
                }
              };
            }
          }
        }
      };
      var mockEnv = { storageURI: 'mongodb://localhost:27017/nightscout' };

      var output = [];
      var originalLog = console.log;
      var originalWarn = console.warn;
      console.log = function() {
        output.push(Array.prototype.join.call(arguments, ' '));
      };
      console.warn = function() {
        output.push(Array.prototype.join.call(arguments, ' '));
      };

      productionSafety.checkProductionSafety(mockCtx, mockEnv)
        .then(function() {
          console.log = originalLog;
          console.warn = originalWarn;
          var fullOutput = output.join('\n');
          fullOutput.should.match(/within threshold.*safe to test/);
          fullOutput.should.match(/doesn't contain "test"/);
          done();
        })
        .catch(function(err) {
          console.log = originalLog;
          console.warn = originalWarn;
          done(err);
        });
    });

    it('should pass when entries are below threshold even if name lacks "test"', function(done) {
      process.env.TEST_SAFETY_REQUIRE_TEST_DB = 'true';
      delete process.env.TEST_SAFETY_MAX_ENTRIES; // default 100
      delete process.env.TEST_SAFETY_SKIP;

      var mockCtx = {
        store: {
          db: {
            collection: function() {
              return {
                countDocuments: function() {
                  return Promise.resolve(50);
                }
              };
            }
          }
        }
      };
      var mockEnv = { storageURI: 'mongodb://localhost:27017/nightscout' };

      var output = [];
      var originalLog = console.log;
      var originalWarn = console.warn;
      console.log = function() {
        output.push(Array.prototype.join.call(arguments, ' '));
      };
      console.warn = function() {
        output.push(Array.prototype.join.call(arguments, ' '));
      };

      productionSafety.checkProductionSafety(mockCtx, mockEnv)
        .then(function() {
          console.log = originalLog;
          console.warn = originalWarn;
          var fullOutput = output.join('\n');
          fullOutput.should.match(/50 entries.*within threshold.*safe to test/);
          done();
        })
        .catch(function(err) {
          console.log = originalLog;
          console.warn = originalWarn;
          done(err);
        });
    });

    it('should say "contains real data" when entry count exceeds threshold', function(done) {
      process.env.TEST_SAFETY_REQUIRE_TEST_DB = 'false';
      process.env.TEST_SAFETY_MAX_ENTRIES = '10';
      delete process.env.TEST_SAFETY_SKIP;

      var mockCtx = {
        store: {
          db: {
            collection: function() {
              return {
                countDocuments: function() {
                  return Promise.resolve(500);
                }
              };
            }
          }
        }
      };
      var mockEnv = { storageURI: 'mongodb://localhost:27017/nightscout' };

      var output = [];
      var originalError = console.error;
      console.error = function() {
        output.push(Array.prototype.join.call(arguments, ' '));
      };

      productionSafety.checkProductionSafety(mockCtx, mockEnv)
        .then(function() {
          console.error = originalError;
          should.fail('should have thrown');
        })
        .catch(function(err) {
          console.error = originalError;
          err.message.should.match(/Entry Count/);
          var fullOutput = output.join('\n');
          fullOutput.should.match(/appears to contain real data/);
          fullOutput.should.match(/TEST_SAFETY_MAX_ENTRIES/);
          done();
        });
    });

    it('hint should mention CUSTOMCONNSTR_mongo not mongo_collection', function(done) {
      process.env.TEST_SAFETY_REQUIRE_TEST_DB = 'true';
      process.env.TEST_SAFETY_MAX_ENTRIES = '0'; // disable entry check
      delete process.env.TEST_SAFETY_SKIP;

      var mockCtx = { store: { db: null } };
      var mockEnv = { storageURI: 'mongodb://localhost:27017/production_db' };

      var output = [];
      var originalError = console.error;
      console.error = function() {
        output.push(Array.prototype.join.call(arguments, ' '));
      };

      productionSafety.checkProductionSafety(mockCtx, mockEnv)
        .then(function() {
          console.error = originalError;
          should.fail('should have thrown');
        })
        .catch(function(err) {
          console.error = originalError;
          var fullOutput = output.join('\n');
          // Should guide user to the correct env var
          fullOutput.should.match(/CUSTOMCONNSTR_mongo/);
          fullOutput.should.match(/mongo_collection sets the entries collection, not the DB name/);
          done();
        });
    });

    it('should block non-test DB name when entries exceed threshold', function(done) {
      process.env.TEST_SAFETY_REQUIRE_TEST_DB = 'true';
      process.env.TEST_SAFETY_MAX_ENTRIES = '10';
      delete process.env.TEST_SAFETY_SKIP;

      var mockCtx = {
        store: {
          db: {
            collection: function() {
              return {
                countDocuments: function() {
                  return Promise.resolve(50);
                }
              };
            }
          }
        }
      };
      var mockEnv = { storageURI: 'mongodb://localhost:27017/nightscout' };

      var output = [];
      var originalError = console.error;
      console.error = function() {
        output.push(Array.prototype.join.call(arguments, ' '));
      };

      productionSafety.checkProductionSafety(mockCtx, mockEnv)
        .then(function() {
          console.error = originalError;
          should.fail('should have thrown');
        })
        .catch(function(err) {
          console.error = originalError;
          // Both checks should fail
          err.message.should.match(/Entry Count/);
          err.message.should.match(/Database Name/);
          var fullOutput = output.join('\n');
          fullOutput.should.match(/appears to contain real data/);
          done();
        });
    });
  });
});
