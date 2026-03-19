'use strict';

/**
 * Production Safety Check for Test Suite
 * 
 * GAP-SYNC-047: Prevents tests from running against production databases
 * by checking multiple safety signals:
 * 
 * 1. Database name should contain "test" (configurable)
 * 2. Entry count should be below threshold (default: 100)
 * 
 * Environment Variables:
 * - TEST_SAFETY_MAX_ENTRIES: Max entries before refusing (default: 100, 0 to disable)
 * - TEST_SAFETY_REQUIRE_TEST_DB: Require "test" in DB name (default: true)
 * - TEST_SAFETY_SKIP: Emergency bypass for all checks (default: false)
 */

const DEFAULT_MAX_ENTRIES = 100;

/**
 * Extract database name from MongoDB connection string
 * @param {string} connectionString - MongoDB URI
 * @returns {string} Database name
 */
function extractDbName(connectionString) {
  try {
    // Handle both mongodb:// and mongodb+srv:// formats
    const url = new URL(connectionString);
    // pathname is /dbname or /dbname?options
    let dbName = url.pathname.slice(1); // Remove leading /
    // Remove query string if present
    const queryIndex = dbName.indexOf('?');
    if (queryIndex > -1) {
      dbName = dbName.slice(0, queryIndex);
    }
    return dbName || 'nightscout';
  } catch (err) {
    // Fallback for non-standard connection strings
    const match = connectionString.match(/\/([^/?]+)(\?|$)/);
    return match ? match[1] : 'unknown';
  }
}

/**
 * Check if database name indicates a test database
 * @param {string} dbName - Database name
 * @returns {boolean} True if looks like test database
 */
function isTestDatabaseName(dbName) {
  const lower = dbName.toLowerCase();
  return lower.includes('test') || 
         lower.includes('_test') || 
         lower.startsWith('test_') ||
         lower.endsWith('_test');
}

/**
 * Run production safety checks
 * 
 * @param {Object} ctx - Boot context with entries collection
 * @param {Object} env - Environment with storageURI
 * @returns {Promise<void>} Resolves if safe, rejects with error if not
 */
async function checkProductionSafety(ctx, env) {
  // Emergency bypass
  if (process.env.TEST_SAFETY_SKIP === 'true') {
    console.warn('[SAFETY] ⚠️  TEST_SAFETY_SKIP=true - All safety checks bypassed!');
    return;
  }

  const errors = [];
  const warnings = [];

  // Check 1: Database name should indicate test
  const requireTestDb = process.env.TEST_SAFETY_REQUIRE_TEST_DB !== 'false';
  const dbName = extractDbName(env.storageURI || env.mongo_connection || '');
  
  if (requireTestDb && !isTestDatabaseName(dbName)) {
    errors.push({
      check: 'Database Name',
      message: `Database "${dbName}" doesn't contain "test" in its name`,
      hint: 'Use a database name like "nightscout_test" or set TEST_SAFETY_REQUIRE_TEST_DB=false'
    });
  } else if (isTestDatabaseName(dbName)) {
    console.log(`[SAFETY] ✅ Database name "${dbName}" looks like a test database`);
  }

  // Check 2: Entry count threshold
  const maxEntries = parseInt(process.env.TEST_SAFETY_MAX_ENTRIES || String(DEFAULT_MAX_ENTRIES), 10);
  
  if (maxEntries > 0 && ctx.entries && ctx.entries.collection) {
    try {
      // Use limit+1 pattern for efficiency - we only need to know if it exceeds threshold
      const count = await ctx.entries.collection.countDocuments({}, { 
        limit: maxEntries + 1,
        maxTimeMS: 5000 // Don't hang on slow connections
      });
      
      if (count > maxEntries) {
        errors.push({
          check: 'Entry Count',
          message: `Database has ${count}+ entries (threshold: ${maxEntries})`,
          hint: `This looks like a production database. Set TEST_SAFETY_MAX_ENTRIES=${count + 100} to override`
        });
      } else {
        console.log(`[SAFETY] ✅ Database has ${count} entries (threshold: ${maxEntries})`);
      }
    } catch (err) {
      warnings.push({
        check: 'Entry Count',
        message: `Could not count entries: ${err.message}`,
        hint: 'Entry count check skipped'
      });
    }
  } else if (maxEntries === 0) {
    console.log('[SAFETY] ⚠️  Entry count check disabled (TEST_SAFETY_MAX_ENTRIES=0)');
  }

  // Report warnings
  warnings.forEach(w => {
    console.warn(`[SAFETY] ⚠️  ${w.check}: ${w.message}`);
  });

  // Report errors and fail
  if (errors.length > 0) {
    console.error('\n' + '='.repeat(70));
    console.error('❌ PRODUCTION SAFETY CHECK FAILED');
    console.error('='.repeat(70));
    console.error('\nTests use deleteMany({}) which could DESTROY PRODUCTION DATA.\n');
    
    errors.forEach((e, i) => {
      console.error(`${i + 1}. ${e.check}:`);
      console.error(`   ${e.message}`);
      console.error(`   💡 ${e.hint}\n`);
    });
    
    console.error('To bypass ALL checks (dangerous): TEST_SAFETY_SKIP=true');
    console.error('='.repeat(70) + '\n');
    
    throw new Error('Production safety check failed: ' + errors.map(e => e.check).join(', '));
  }

  console.log('[SAFETY] ✅ All production safety checks passed');
}

/**
 * Synchronous pre-flight check (no DB required)
 * Run this before booting the application
 */
function preflightCheck() {
  // Check NODE_ENV
  if (process.env.NODE_ENV !== 'test') {
    console.error('\n❌ SAFETY ERROR: NODE_ENV must be "test" to run tests.');
    console.error('   Current value: ' + (process.env.NODE_ENV || '(not set)'));
    console.error('   Tests use deleteMany({}) which could destroy production data.');
    console.error('   Fix: Use "npm test" which loads my.test.env, or set NODE_ENV=test\n');
    process.exit(1);
  }
}

module.exports = {
  checkProductionSafety,
  preflightCheck,
  extractDbName,
  isTestDatabaseName,
  DEFAULT_MAX_ENTRIES
};
