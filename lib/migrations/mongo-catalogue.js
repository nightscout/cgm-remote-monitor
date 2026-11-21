'use strict';

const { MigrationError, checksum } = require('./catalogue');

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));
const fields = value => plain(value) && Object.keys(value).length > 0 &&
  Object.entries(value).every(([key, item]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && scalar(item));

function validateCatalogue (input) {
  if (!input || input.version !== 1 || input.backend !== 'mongodb' ||
      !Array.isArray(input.migrations) || !input.migrations.length || input.migrations.length > 1000) {
    throw new MigrationError('MIG_CATALOGUE', 'a bounded nonempty version 1 mongodb catalogue is required');
  }
  let previous = '';
  return input.migrations.map(m => {
    if (!m || typeof m.name !== 'string' || !/^\d{4}_[a-z0-9_]+$/.test(m.name) ||
        m.name <= previous || m.transactional !== true) {
      throw new MigrationError('MIG_CATALOGUE', 'MongoDB migrations require ordered unique names and transactional: true');
    }
    previous = m.name;
    if (!Array.isArray(m.up) || !m.up.length || m.up.length > 100 || m.up.some(step =>
      !plain(step) || Object.keys(step).sort().join(',') !== 'collection,filter,set' ||
      typeof step.collection !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(step.collection) ||
      step.collection.startsWith('system') || !fields(step.filter) || !fields(step.set) ||
      Object.hasOwn(step.set, '_id'))) {
      throw new MigrationError('MIG_CATALOGUE', 'MongoDB steps require a collection, nonempty scalar equality filter and scalar set fields without _id');
    }
    if (typeof m.checksum !== 'string' || m.checksum !== checksum(m.up)) {
      throw new MigrationError('MIG_CHECKSUM', 'catalogue checksum mismatch: ' + m.name);
    }
    // Copy nested caller-owned objects before any asynchronous work.
    return JSON.parse(JSON.stringify({ name: m.name, up: m.up, checksum: m.checksum }));
  });
}

module.exports = { validateCatalogue };
