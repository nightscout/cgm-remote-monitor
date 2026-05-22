'use strict';

require('should');

describe('API3 PATCH operation', function () {
  const should = require('should');
  const security = require('../lib/api3/security');
  const patchOperation = require('../lib/api3/generic/patch/operation');

  let originalAuthenticate;
  let originalDemandPermission;

  beforeEach(() => {
    originalAuthenticate = security.authenticate;
    originalDemandPermission = security.demandPermission;
  });

  afterEach(() => {
    security.authenticate = originalAuthenticate;
    security.demandPermission = originalDemandPermission;
  });

  it('emits the merged patched document without re-reading storage', async () => {
    const date = 1741255200000;
    const storageDoc = {
      identifier: 'test-patch-operation',
      date: date,
      utcOffset: 0,
      app: 'nightscout-test',
      device: 'ns://pump',
      eventType: 'Temp Basal',
      absolute: 1.2,
      duration: 30,
      srvModified: date - 1000
    };
    const patchDoc = {
      absolute: 0.7,
      duration: 0,
      durationInMilliseconds: 26584
    };
    const events = [];

    security.authenticate = async () => ({ subject: { name: 'patch-user' } });
    security.demandPermission = async () => true;

    const col = {
      colName: 'treatments',
      storage: {
        identifyingFilter: identifier => ({ identifier }),
        findOneFilter: async () => [Object.assign({}, storageDoc)],
        updateOne: async () => ({ updated: 1 }),
        findOne: async () => {
          throw new Error('PATCH should not re-read the document after update');
        }
      },
      resolveDates: doc => new Date(doc.srvModified),
      autoPrune: () => {
        events.push({ name: 'auto-prune' });
      }
    };
    const ctx = {
      bus: {
        emit: (name, payload) => {
          events.push({ name, payload });
        }
      }
    };
    const req = {
      body: Object.assign({}, patchDoc),
      params: { identifier: storageDoc.identifier },
      get: () => null
    };
    const res = createResponse();
    const handler = patchOperation(ctx, {}, {}, col);

    await handler(req, res);

    res.statusCode.should.equal(200);
    should.exist(res.headers['Last-Modified']);

    const updateEvent = events.find(event => event.name === 'storage-socket-update');
    should.exist(updateEvent);
    updateEvent.payload.colName.should.equal('treatments');
    updateEvent.payload.doc.should.containEql({
      identifier: storageDoc.identifier,
      absolute: 0.7,
      duration: 0,
      durationInMilliseconds: 26584,
      modifiedBy: 'patch-user'
    });
    updateEvent.payload.doc.endmills.should.equal(date + 26584);
  });
});

function createResponse () {
  return {
    headers: {},
    headersSent: false,
    statusCode: null,
    body: null,
    setHeader (name, value) {
      this.headers[name] = value;
    },
    status (code) {
      this.statusCode = code;
      return this;
    },
    json (body) {
      this.body = body;
      this.headersSent = true;
      return this;
    }
  };
}
