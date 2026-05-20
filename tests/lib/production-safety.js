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

  // Check 1: Entry count threshold (run first — an empty DB is always safe)
  const maxEntries = parseInt(process.env.TEST_SAFETY_MAX_ENTRIES || String(DEFAULT_MAX_ENTRIES), 10);
  let entryCount = 0;
  let entryCountChecked = false;
  
  if (maxEntries > 0 && ctx.store && ctx.store.db) {
    try {
      const entriesCol = ctx.store.db.collection('entries');
      entryCount = await entriesCol.countDocuments({}, { 
        limit: maxEntries + 1,
        maxTimeMS: 5000
      });
      entryCountChecked = true;
      
      if (entryCount > maxEntries) {
        errors.push({
          check: 'Entry Count',
          message: `Database has ${entryCount}+ entries (threshold: ${maxEntries})`,
          hint: `This looks like a production database. Set TEST_SAFETY_MAX_ENTRIES=${entryCount + 100} to override`
        });
      } else {
        console.log(`[SAFETY] ✅ Database has ${entryCount} entries (threshold: ${maxEntries})`);
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

  // Check 2: Database name should indicate test
  // If entry count is within threshold, the DB is safe regardless of name — downgrade to warning
  const requireTestDb = process.env.TEST_SAFETY_REQUIRE_TEST_DB !== 'false';
  const dbName = extractDbName(env.storageURI || env.mongo_connection || '');
  const entryCountSafe = entryCountChecked && entryCount <= maxEntries;
  
  if (requireTestDb && !isTestDatabaseName(dbName)) {
    if (entryCountSafe) {
      console.log(`[SAFETY] ✅ Database "${dbName}" has ${entryCount} entries (within threshold) — safe to test`);
      warnings.push({
        check: 'Database Name',
        message: `Database "${dbName}" doesn't contain "test" in its name (allowed because entry count is within threshold)`,
        hint: 'Consider renaming: set CUSTOMCONNSTR_mongo=mongodb://localhost/nightscout_test in my.test.env'
      });
    } else {
      errors.push({
        check: 'Database Name',
        message: `Database "${dbName}" doesn't contain "test" in its name`,
        hint: 'Set the database name in CUSTOMCONNSTR_mongo (e.g., mongodb://localhost/nightscout_test)\n         Note: CUSTOMCONNSTR_mongo_collection sets the entries collection, not the DB name.\n         Or set TEST_SAFETY_REQUIRE_TEST_DB=false to allow any DB name'
      });
    }
  } else if (isTestDatabaseName(dbName)) {
    console.log(`[SAFETY] ✅ Database name "${dbName}" looks like a test database`);
  }

  // Report warnings
  warnings.forEach(w => {
    console.warn(`[SAFETY] ⚠️  ${w.check}: ${w.message}`);
  });

  // Report errors and fail
  if (errors.length > 0) {
    const hasEntryCountError = errors.some(e => e.check === 'Entry Count');
    const hasDbNameError = errors.some(e => e.check === 'Database Name');

    console.error('\n' + '='.repeat(70));
    console.error('🛡️  PRODUCTION SAFETY CHECK ACTIVATED');
    console.error('='.repeat(70));
    if (hasEntryCountError) {
      console.error('\nThis database appears to contain real data.');
      console.error('Running the test suite WILL DELETE all data in this database.');
    } else {
      console.error('\nThis database does not look like a test database.');
      console.error('Running the test suite WILL DELETE all data in this database.');
    }
    console.error('\nThis safety check exists to prevent accidental destruction of');
    console.error('production data. If this is truly a test database, you can override.\n');
    
    errors.forEach((e, i) => {
      console.error(`${i + 1}. ${e.check}:`);
      console.error(`   ${e.message}`);
      console.error(`   💡 ${e.hint}\n`);
    });
    
    console.error('Override options:');
    if (hasDbNameError) {
      console.error('  • Rename your test DB: set CUSTOMCONNSTR_mongo=mongodb://localhost/nightscout_test in my.test.env');
      console.error('  • Or set TEST_SAFETY_REQUIRE_TEST_DB=false to allow any DB name');
    }
    if (hasEntryCountError) {
      console.error('  • Set TEST_SAFETY_MAX_ENTRIES to a higher value if entries are expected');
    }
    console.error('  • Set TEST_SAFETY_SKIP=true to bypass ALL checks (dangerous!)');
    console.error('='.repeat(70) + '\n');
    
    throw new Error('Production safety check activated: ' + errors.map(e => e.check).join(', '));
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
