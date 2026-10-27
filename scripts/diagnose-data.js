'use strict';

// Read-only, bounded, aggregate diagnostics. Never print credentials, record
// identifiers, notes, glucose readings or other stored field values.
const {MongoClient} = require('mongodb');
const contract = require('../lib/storage/read-contract');
const envValue = require('../lib/utils/env-value');

async function report(db, names, limit) {
  const report = {};
  for (const [logical, physical] of Object.entries(names)) {
    const summary = {scanned: 0, flagged: 0, rules: Object.create(null), truncated: false};
    const cursor = db.collection(physical).find({}).limit(limit + 1).batchSize(500);
    try {
      for await (const doc of cursor) {
        if (summary.scanned === limit) { summary.truncated = true; break; }
        summary.scanned++;
        const issues = contract.inspect(doc);
        if (issues.length) summary.flagged++;
        for (const {rule} of issues) summary.rules[rule] = (summary.rules[rule] || 0) + 1;
      }
    } finally { await cursor.close(); }
    report[logical] = summary;
  }
  return report;
}

// Use the same trimmed keys, aliases and precedence as the server without
// initializing its full configuration or logging any environment values.
function collectionNames(source) {
  const normalized = {};
  for (const [key, value] of Object.entries(source)) normalized[key.trim()] = value.trim();
  const read = (name, fallback) => {
    const value = envValue(normalized, name);
    return value != null ? value : fallback;
  };
  return {
    entries: read('ENTRIES_COLLECTION') || read('MONGO_COLLECTION', 'entries'),
    treatments: read('MONGO_TREATMENTS_COLLECTION', 'treatments'),
    devicestatus: read('MONGO_DEVICESTATUS_COLLECTION', 'devicestatus'),
    profile: read('MONGO_PROFILE_COLLECTION', 'profile'),
    food: read('MONGO_FOOD_COLLECTION', 'food'),
    settings: read('MONGO_SETTINGS_COLLECTION', 'settings')
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--limit' || !/^[1-9][0-9]*$/.test(args[1]))) {
    throw new Error('Usage: npm run diagnose:data -- [--limit 10000]');
  }
  const limit = args.length ? Number(args[1]) : 10000;
  if (!Number.isSafeInteger(limit) || limit > 1000000) throw new Error('Limit must be between 1 and 1000000');
  const uri = process.env.MONGODB_URI || process.env.CUSTOMCONNSTR_mongo;
  if (!uri) throw new Error('Set MONGODB_URI before running the read-only report');
  const client = new MongoClient(uri, {maxPoolSize: 1, serverSelectionTimeoutMS: 10000});
  try {
    await client.connect();
    const names = collectionNames(process.env);
    process.stdout.write(JSON.stringify(await report(client.db(), names, limit), null, 2) + '\n');
  } finally { await client.close(); }
}

if (require.main === module) main().catch(() => {
  // Driver errors can contain a URI, query or a stored value. Keep CLI output
  // safe to attach to an issue; deliberately do not echo the driver message.
  console.error('Data diagnosis failed. Check the URI, read permission and --limit (1–1000000).');
  process.exitCode = 1;
});
module.exports = {report, collectionNames};
