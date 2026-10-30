#!/usr/bin/env node
'use strict';

// ID-UNIQUE-INDEX operator tool: report, and resolve, the records that share
// an `identifier` and so keep the unique index on identifier from being built
// (WRITE_IDENTIFIER_INDEX, lib/storage/identifier-index.js).
//
//   node tools/identifier-duplicates.js report  [--collections treatments,entries] [--show-identifiers]
//   node tools/identifier-duplicates.js resolve [--collections ...] [--apply]
//
// It connects as the server does (MONGODB_URI, MONGO_CONNECTION, ... and the
// MONGO_*_COLLECTION names, read by lib/server/env.js). Stop the server, or
// expect its writes to interleave, and take a backup before --apply.
//
// report: per collection, how many identifiers are each held by more than one
// record and how many records hold them; per group, the _ids and the record
// P4 picks. Identifier values are printed only with --show-identifiers.
//
// resolve: per group, the record P4 picks (p4Pick in lib/storage/write-intent.js;
// with no write to compare a time with, the newest by _id) keeps the
// identifier. Every other record of the group:
//   - a twin of the pick (the string spelling of the pick's ObjectId _id, or
//     the reverse: one record stored twice, BF-130) is removed, as a write
//     removes a string twin;
//   - any other record is kept, with its identifier (the whole stored value,
//     an array as it is) moved to `identifierReleased` and srvModified set to
//     now, so a client that syncs by srvModified sees the change. Two halves
//     of a chart split are both real records; neither is removed.
// Groups are by index key, as the index sees them: a stored identifier array
// is one key per element, so a record can be in more than one group (run
// report again after resolve).
// Without --apply, resolve prints what it would do and writes nothing. Run the
// server again afterwards: under WRITE_IDENTIFIER_INDEX=try it builds the index
// at boot once no group is left.

const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const identifierIndex = require('../lib/storage/identifier-index');
const writeIntent = require('../lib/storage/write-intent');

const COLLECTIONS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];

function collectionNames (env) {
  return {
    entries: env.entries_collection || 'entries'
    , treatments: env.treatments_collection || 'treatments'
    , devicestatus: env.devicestatus_collection || 'devicestatus'
    , profile: env.profile_collection || 'profile'
    , food: env.food_collection || 'food'
    , activity: env.activity_collection || 'activity'
    , settings: env.settings_collection || 'settings'
  };
}

function idKey (id) {
  return id instanceof ObjectId ? id.toHexString().toLowerCase() : String(id).toLowerCase();
}

function isTwin (a, b) {
  return (a instanceof ObjectId) !== (b instanceof ObjectId) && idKey(a) === idKey(b);
}

// The plan for one group: its records newest _id first (P4's order), the pick
// and what happens to each other record.
async function planGroup (collection, name, group) {
  const records = await collection.find({ _id: { $in: group.ids } }, { projection: { _id: 1, identifier: 1 } })
    .sort({ _id: -1 }).toArray();
  const pick = writeIntent.p4Pick(records, { }, writeIntent.P4_TIME_KEYS[name] || [ ], name + ' identifier-duplicates');
  const others = records.filter(function (doc) { return doc !== pick; }).map(function (doc) {
    return { _id: doc._id, action: isTwin(doc._id, pick._id) ? 'remove-twin' : 'release' };
  });
  return { identifier: group._id, count: records.length, pick: pick._id, others: others };
}

/**
 * @param {Object} db a connected Db
 * @param {Object} names logical name -> MongoDB collection name
 * @param {string[]} which logical names
 * @param {{ apply?: boolean, resolve?: boolean, log?: function }} options
 * @returns {Promise<Object>} per collection { identifiers, records, groups: [...] , applied }
 */
async function run (db, names, which, options) {
  const opts = options || { };
  const out = { };
  for (const name of which) {
    const collection = db.collection(names[name]);
    const counts = await identifierIndex.duplicateCounts(collection);
    const groups = [ ];
    if (counts.identifiers > 0) {
      for (const group of await identifierIndex.duplicateGroups(collection)) {
        groups.push(await planGroup(collection, name, group));
      }
    }
    const result = { identifiers: counts.identifiers, records: counts.records, groups: groups, applied: false };
    if (opts.resolve && opts.apply && groups.length > 0) {
      const now = Date.now();
      for (const group of groups) {
        for (const other of group.others) {
          if (other.action === 'remove-twin') {
            await collection.deleteOne({ _id: other._id });
          } else {
            // The whole stored value moves (an array identifier as it is).
            await collection.updateOne({ _id: other._id, identifier: { $exists: true } }
              , [{ $set: { identifierReleased: '$identifier', srvModified: now } }, { $unset: 'identifier' }]);
          }
        }
      }
      result.applied = true;
    }
    out[name] = result;
  }
  return out;
}

function printable (id) {
  return id instanceof ObjectId ? 'ObjectId(' + id.toHexString() + ')' : JSON.stringify(id);
}

function print (result, options) {
  Object.keys(result).forEach(function (name) {
    const r = result[name];
    console.log(name + ': ' + r.identifiers + ' identifier(s) held by more than one record (' + r.records + ' records)'
      + (r.applied ? '; resolved' : ''));
    r.groups.forEach(function (group, index) {
      console.log('  group ' + (index + 1) + (options.showIdentifiers ? ' identifier ' + JSON.stringify(group.identifier) : '')
        + ': ' + group.count + ' records; keeps it: ' + printable(group.pick));
      group.others.forEach(function (other) {
        console.log('    ' + printable(other._id) + ': ' + (other.action === 'remove-twin' ? 'removed (a twin of the pick)'
          : 'kept, identifier moved to identifierReleased'));
      });
    });
  });
}

async function main (argv) {
  const command = argv[0];
  if (command !== 'report' && command !== 'resolve') {
    console.error('usage: node tools/identifier-duplicates.js report|resolve [--collections a,b] [--apply] [--show-identifiers]');
    return 2;
  }
  const flag = function (name) { return argv.indexOf(name) !== -1; };
  const at = argv.indexOf('--collections');
  const which = at === -1 ? COLLECTIONS : argv[at + 1].split(',');
  const unknown = which.filter(function (name) { return COLLECTIONS.indexOf(name) === -1; });
  if (unknown.length > 0) {
    console.error('unknown collection(s): ' + unknown.join(', '));
    return 2;
  }
  const env = require(path.join(__dirname, '../lib/server/env'))();
  if (!env.storageURI) {
    console.error('no MongoDB connection string (MONGODB_URI, MONGO_CONNECTION, ...)');
    return 2;
  }
  const client = await MongoClient.connect(env.storageURI);
  try {
    const result = await run(client.db(), collectionNames(env), which
      , { resolve: command === 'resolve', apply: flag('--apply') });
    print(result, { showIdentifiers: flag('--show-identifiers') });
    if (command === 'resolve' && !flag('--apply')) console.log('(dry run: nothing written; add --apply)');
    return 0;
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (err) {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = { run, planGroup, collectionNames, COLLECTIONS };
