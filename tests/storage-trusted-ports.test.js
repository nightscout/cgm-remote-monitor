'use strict';

const assert = require('node:assert/strict');
const reads = require('../lib/server/storage-reads');

describe('trusted legacy storage ports', function () {
  it('uses the same logical source for reads and intents without a Mongo handle', function () {
    const calls = [];
    const step = { write () {} };
    const storage = { findFiltered () {} };
    const options = { env: {}, bus: {} };
    const ctx = { storagePorts: { resolve (selection) {
      calls.push(selection);
      return { storage, intentFactory (actual) { assert.equal(actual, options); return step; } };
    } } };
    assert.equal(reads.collection(ctx, {}, 'ignored', 'entries'), storage);
    assert.equal(reads.intent(ctx, 'entries', 'v1/internal', options, () => {
      throw new Error('Mongo fallback reached');
    }), step);
    assert.deepEqual(calls, [
      { logical: 'entries', source: 'v1/internal' },
      { logical: 'entries', source: 'v1/internal' }
    ]);
  });

  it('refuses incomplete tenant ports instead of falling back', function () {
    for (const storagePorts of [null, {}, { resolve: () => null },
      { resolve: () => ({ storage: { findFiltered () {} } }) }]) {
      assert.throws(() => reads.collection({ storagePorts }, {}, 'entries', 'entries'), TypeError);
      assert.throws(() => reads.intent({ storagePorts }, 'entries', 'v1/internal', {}, () => {
        throw new Error('Mongo fallback reached');
      }), TypeError);
    }
  });

  it('retains the single application intent factory when injection is absent', function () {
    const expected = {};
    assert.equal(reads.intent({}, 'entries', 'v1/internal', {}, () => expected), expected);
  });
});


describe('preview domain and storage failure boundaries', function () {
  it('keeps logical metadata distinct from backend factories and schemas', function () {
    const catalogue = require('../lib/server/tenant-app/domain-catalogue');
    for (const name of catalogue.names) {
      const domain = catalogue.get(name);
      assert.equal(domain.logical, name);
      assert.equal(Object.hasOwn(domain, 'factory'), false);
      assert.equal(Object.hasOwn(domain, 'catalogue'), false);
    }
    assert.throws(() => catalogue.get('arbitrary-request-name'), /Unknown preview domain/);
  });

  it('recognizes dependency failures through wrapped causes without classifying input or internal errors', function () {
    const { isUnavailable } = require('../lib/storage/failures');
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03',
      '53300', '42501', '08006', '08P01']) {
      const original = Object.assign(new Error('synthetic dependency'), { code });
      assert.equal(isUnavailable(original), true, code);
      assert.equal(isUnavailable(new Error('wrapped', { cause: original })), true, code);
    }
    for (const error of [undefined, null, new TypeError('invalid'), { unsupported: true },
      { code: '42P01' }, { code: '23505' }, { code: 8006 }]) assert.equal(isUnavailable(error), false);
    const cyclic = new Error('cycle');
    cyclic.cause = cyclic;
    assert.equal(isUnavailable(cyclic), false);
  });

  it('renders a wrapped dependency as 503 through actual API3 HTTP and keeps unvalidated unsupported errors internal', async function () {
    const express = require('express');
    const request = require('supertest');
    const Collection = require('../lib/api3/generic/collection');
    const transport = require('../lib/server/tenant-app/profile-food-errors');
    const outage = new Error('synthetic wrapped outage', {
      cause: Object.assign(new Error('synthetic connection failed'), { code: 'ECONNRESET' })
    });
    let fault = outage;
    const app = express();
    app.setENVTruthy = () => false;
    const options = transport({ storage: { async findMany () { throw fault; } } });
    const collection = new Collection({ ctx: {}, env: {}, app, colName: 'food', storageColName: 'food', ...options });
    collection.mapRoutes();
    const unavailable = await request(app).get('/food').expect(503);
    assert.deepEqual(unavailable.body, { error: 'STORAGE_UNAVAILABLE' });
    fault = Object.assign(new Error('runtime marker is not submitted validation'), { unsupported: true });
    await request(app).get('/food').expect(500);
  });

});
