'use strict';
const { EventEmitter } = require('node:events');
function matchesValue (actual, condition) {
  if (condition && typeof condition === 'object') {
    if (condition.$in) {
      return !Array.isArray(actual) && condition.$in.some(function (value) {
        return actual === value || (actual === undefined && value === null);
      });
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$eq')) {
      return actual === condition.$eq || (actual === undefined && condition.$eq === null);
    }
    // The dedup lookups skip deleted records with {isValid: {$ne: false}} (BF-122 / JL-1).
    if (Object.prototype.hasOwnProperty.call(condition, '$ne')) {
      return actual !== condition.$ne;
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$gte') && actual < condition.$gte) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$lte') && actual > condition.$lte) {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(condition, '$gte')
      || Object.prototype.hasOwnProperty.call(condition, '$lte');
  }
  return require('node:util').isDeepStrictEqual(actual, condition);
}

function matchesQuery (document, query) {
  return Object.keys(query).every(function (field) {
    // A write the step scoped to the _ids it resolved (WC-STEP-PATCH release 2).
    if (field === '$and') {
      return query.$and.every(function (part) { return matchesQuery(document, part); });
    }
    return matchesValue(document[field], query[field]);
  });
}

function fakeCollection () {
  var documents = [];
  var queries = [];
  var writes = [];
  var nextId = 1;

  function findIndex (query) {
    return documents.findIndex(function (document) {
      return matchesQuery(document, query);
    });
  }

  return {
    documents: documents,
    queries: queries,
    writes: writes,
    findOne: function (query) {
      queries.push(query);
      var index = findIndex(query);
      return Promise.resolve(index === -1 ? null : Object.assign({}, documents[index]));
    },
    // The socket reads through the storage interface, which reads a cursor:
    // find(query).limit(1).toArray() is findOne(query).
    find: function (query) {
      queries.push(query);
      var limit = Infinity;
      var cursor = {
        sort: function () { return cursor; },
        skip: function () { return cursor; },
        project: function () { return cursor; },
        limit: function (n) { limit = n; return cursor; },
        toArray: function () {
          return Promise.resolve(documents.filter(function (document) {
            return matchesQuery(document, query);
          }).slice(0, limit).map(function (document) { return Object.assign({}, document); }));
        }
      };
      return cursor;
    },
    insertOne: function (document) {
      var id = Object.prototype.hasOwnProperty.call(document, '_id') ? document._id : 'generated-' + nextId++;
      var stored = Object.assign({}, document, {_id: id});
      writes.push({operation: 'insertOne', document: stored});
      documents.push(stored);
      return Promise.resolve({insertedId: id});
    },
    updateOne: function (selector, update) {
      writes.push({operation: 'updateOne', selector: selector, update: update});
      var index = findIndex(selector);
      if (index !== -1 && update.$set) {
        Object.assign(documents[index], update.$set);
      }
      if (index !== -1 && update.$unset) {
        Object.keys(update.$unset).forEach(function (field) {
          delete documents[index][field];
        });
      }
      return Promise.resolve({matchedCount: index === -1 ? 0 : 1});
    },
    replaceOne: function (selector, replacement) {
      writes.push({operation: 'replaceOne', selector: selector, replacement: replacement});
      var index = findIndex(selector);
      if (index !== -1) documents[index] = Object.assign({}, replacement);
      return Promise.resolve({matchedCount: index === -1 ? 0 : 1});
    },
    deleteOne: function (selector) {
      writes.push({operation: 'deleteOne', selector: selector});
      var index = findIndex(selector);
      if (index !== -1) documents.splice(index, 1);
      return Promise.resolve({deletedCount: index === -1 ? 0 : 1});
    }
  };
}


function context () {
  const names = ['activity', 'devicestatus', 'entries', 'food', 'profile', 'treatments'];
  const collections = Object.fromEntries(names.map(name => [name, fakeCollection()]));
  const env = Object.fromEntries(names.map(name => [name + '_collection', name]));
  Object.assign(env, { enclave: { isApiKeySet: () => true }, name: 'synthetic', version: '0.0.0',
    settings: { enable: [], isEnabled: () => false } });
  const ctx = { authorization: { checkMultiple: () => true,
    resolve: (credentials, callback) => callback(null, { shiros: [] }) },
    bus: new EventEmitter(), ddata: { clone: () => ({}), processRawDataForRuntime: docs => docs },
    purifier: require('../../../lib/server/purifier')(),
    store: { collection: name => collections[name] } };
  return { env, ctx, collections };
}
module.exports = { context };
