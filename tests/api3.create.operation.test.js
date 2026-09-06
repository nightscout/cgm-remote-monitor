'use strict';

require('should');

const security = require('../lib/api3/security');
const createOperation = require('../lib/api3/generic/create/operation');

describe('API3 CREATE operation authorization and selector ordering', function () {
  let originalAuthenticate;
  let originalConsoleError;
  let originalConsoleLog;
  let originalConsoleWarn;

  beforeEach(function () {
    originalAuthenticate = security.authenticate;
    originalConsoleError = console.error;
    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    console.error = function () {};
    console.log = function () {};
    console.warn = function () {};
  });

  afterEach(function () {
    security.authenticate = originalAuthenticate;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
  });

  it('rejects an invalid identifier before querying storage', async function () {
    const observed = { findCalls: 0 };
    const doc = validDocument();
    doc.identifier = { $ne: null };
    security.authenticate = async function () {
      return authWith('api:settings:create');
    };

    const handler = createOperation({}, {}, {}, createCollection(observed, []));
    const res = createResponse();

    await handler(createRequest(doc), res);

    res.statusCode.should.equal(400);
    res.body.message.should.equal('Bad or missing identifier field');
    observed.findCalls.should.equal(0);
  });

  it('does not let update-only authorization insert a missing document', async function () {
    const observed = { findCalls: 0, insertCalls: 0 };
    security.authenticate = async function () {
      return authWith('api:settings:update');
    };

    const handler = createOperation({}, {}, {}, createCollection(observed, []));
    const res = createResponse();

    await handler(createRequest(validDocument()), res);

    res.statusCode.should.equal(403);
    res.body.message.should.equal('Missing permission api:settings:create');
    observed.findCalls.should.equal(1);
    observed.insertCalls.should.equal(0);
  });

  it('rejects callers without write authorization before querying storage', async function () {
    const observed = { findCalls: 0 };
    security.authenticate = async function () {
      return authWith('api:settings:read');
    };

    const handler = createOperation({}, {}, {}, createCollection(observed, []));
    const res = createResponse();

    await handler(createRequest(validDocument()), res);

    res.statusCode.should.equal(403);
    res.body.message.should.equal('Missing permission api:settings:create');
    observed.findCalls.should.equal(0);
  });

  it('does not let create-only authorization replace an existing document', async function () {
    const observed = { findCalls: 0, replaceCalls: 0 };
    security.authenticate = async function () {
      return authWith('api:settings:create');
    };

    const doc = validDocument();
    const storedDoc = Object.assign({}, doc);
    const handler = createOperation({}, {}, {}, createCollection(observed, [storedDoc]));
    const res = createResponse();

    await handler(createRequest(doc), res);

    res.statusCode.should.equal(403);
    res.body.message.should.equal('Missing permission api:settings:update');
    observed.findCalls.should.equal(1);
    observed.replaceCalls.should.equal(0);
  });
});

function authWith (permission) {
  return {
    shiros: [{
      check: function (requestedPermission) {
        return requestedPermission === permission;
      }
    }]
  };
}

function validDocument () {
  return {
    date: Date.now(),
    utcOffset: 0,
    app: 'api3-selector-test',
    device: 'test-device'
  };
}

function createCollection (observed, foundDocs) {
  return {
    colName: 'settings',
    dedupFallbackFields: [],
    parseDate: function () {},
    autoPrune: function () {},
    storage: {
      identifyingFilter: function (identifier) {
        return { identifier };
      },
      findOneFilter: async function () {
        observed.findCalls += 1;
        return foundDocs;
      },
      insertOne: async function () {
        observed.insertCalls = (observed.insertCalls || 0) + 1;
        return 'inserted';
      },
      replaceOne: async function () {
        observed.replaceCalls = (observed.replaceCalls || 0) + 1;
        return 1;
      }
    }
  };
}

function createRequest (body) {
  return {
    body,
    baseUrl: '/api/v3',
    path: '/settings'
  };
}

function createResponse () {
  return {
    headers: {},
    headersSent: false,
    statusCode: null,
    body: null,
    setHeader: function (name, value) {
      this.headers[name] = value;
    },
    status: function (code) {
      this.statusCode = code;
      return this;
    },
    json: function (body) {
      this.body = body;
      this.headersSent = true;
      return this;
    }
  };
}
