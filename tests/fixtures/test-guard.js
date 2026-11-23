'use strict';

/**
 * Test Database Safety Guards (GAP-SYNC-046)
 * 
 * Prevents destructive operations (deleteMany, drop) from running
 * against production databases when NODE_ENV is not 'test'.
 * 
 * Usage in tests:
 *   const { requireTestEnv, guardedDeleteMany } = require('./fixtures/test-guard');
 *   
 *   before(function() {
 *     requireTestEnv();  // Throws if NODE_ENV !== 'test'
 *   });
 *   
 *   afterEach(function(done) {
 *     guardedDeleteMany(collection, {}, done);
 *   });
 */

const ALLOWED_TEST_DB_PATTERNS = [
  /nightscout.*test/i,
  /test.*nightscout/i,
  /localhost.*test/i,
  /127\.0\.0\.1.*test/i
];

/**
 * Throws if NODE_ENV is not 'test'
 * Call this at the start of test files that perform destructive operations
 */
function requireTestEnv() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'SAFETY: Tests require NODE_ENV=test to prevent accidental production data loss.\n' +
      'Current NODE_ENV: ' + (process.env.NODE_ENV || '(not set)') + '\n' +
      'Fix: Set NODE_ENV=test in your test environment or use ci.test.env'
    );
  }
}

/**
 * Validates that MONGO_CONNECTION points to a test database
 */
function requireTestDatabase() {
  const mongoConn = process.env.MONGO_CONNECTION || '';
  const isTestDb = ALLOWED_TEST_DB_PATTERNS.some(pattern => pattern.test(mongoConn));
  
  if (!isTestDb && process.env.NODE_ENV === 'test') {
    console.warn(
      'WARNING: MONGO_CONNECTION does not appear to be a test database: ' + mongoConn + '\n' +
      'Expected patterns: ' + ALLOWED_TEST_DB_PATTERNS.map(p => p.toString()).join(', ')
    );
  }
  
  return isTestDb;
}

/**
 * Guarded deleteMany - only executes if NODE_ENV=test
 * @param {Collection} collection - MongoDB collection
 * @param {Object} filter - Delete filter (usually {})
 * @param {Function} callback - Callback when complete
 */
function guardedDeleteMany(collection, filter, callback) {
  if (process.env.NODE_ENV !== 'test') {
    const err = new Error(
      'SAFETY: deleteMany({}) blocked - NODE_ENV is not "test".\n' +
      'This prevents accidental deletion of production data.'
    );
    if (callback) {
      return callback(err);
    }
    throw err;
  }
  
  // Safe to proceed
  const promise = collection.deleteMany(filter);
  if (callback) {
    promise.then(
      function onSuccess(result) { callback(null, result); },
      function onError(err) { callback(err); }
    );
  }
  return promise;
}

/**
 * Guarded drop - only executes if NODE_ENV=test
 * @param {Collection} collection - MongoDB collection
 * @param {Function} callback - Callback when complete
 */
function guardedDrop(collection, callback) {
  if (process.env.NODE_ENV !== 'test') {
    const err = new Error(
      'SAFETY: drop() blocked - NODE_ENV is not "test".\n' +
      'This prevents accidental deletion of production data.'
    );
    if (callback) {
      return callback(err);
    }
    throw err;
  }
  
  const promise = collection.drop();
  if (callback) {
    promise.then(
      function onSuccess(result) { callback(null, result); },
      function onError(err) { callback(err); }
    );
  }
  return promise;
}

/**
 * Check test environment at module load time
 * Prints warning if not in test mode
 */
function checkTestEnvironment() {
  if (process.env.NODE_ENV !== 'test') {
    console.warn('\n⚠️  WARNING: NODE_ENV is not "test"');
    console.warn('   Destructive test operations may be blocked.\n');
  }
}

// Check on require
checkTestEnvironment();

module.exports = {
  requireTestEnv,
  requireTestDatabase,
  guardedDeleteMany,
  guardedDrop,
  checkTestEnvironment,
  ALLOWED_TEST_DB_PATTERNS
};
