'use strict';

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const insert = require('../lib/api3/generic/create/insert');
const replace = require('../lib/api3/generic/update/replace');

describe('API3 document Location headers', function () {
  for (const identifier of ['8c59e104-14cf-5bac-90e2-a47e502baaac', '65b000000000000000000001']) {
    for (const deduplicate of [false, true]) {
      it('uses the collection resource for ' + (deduplicate ? 'deduplicated ' : 'created ') + identifier, async function () {
        const doc = {identifier, date: 1704067200000, utcOffset: 0, app: 'location-fixture', device: 'fixture'};
        const res = {headers: {}, setHeader(name, value) {this.headers[name] = value;},
          status(code) {this.statusCode = code; return this;}, json(body) {this.body = body; return this;}};
        const ctx = {bus: new EventEmitter()};
        const opCtx = {ctx, auth: {shiros: [{check: () => true}]}, res,
          // Location must not depend on arbitrary request URL/proxy metadata.
          req: {baseUrl: '/\\external.example', path: '/elsewhere', headers: {host: 'external.example'}},
          col: {colName: 'treatments', autoPrune() {}, storage: {
            insertOne: async () => identifier, replaceOne: async () => 1
          }}};
        if (deduplicate) await replace(opCtx, {...doc}, {...doc}, {isDeduplication: true});
        else await insert(opCtx, {...doc});
        assert.equal(res.statusCode, deduplicate ? 200 : 201);
        assert.equal(res.headers.Location, '/api/v3/treatments/' + identifier);
        assert.equal(new URL(res.headers.Location, 'https://nightscout.example').origin, 'https://nightscout.example');
        assert.equal(res.body.identifier, identifier);
      });
    }
  }
});
