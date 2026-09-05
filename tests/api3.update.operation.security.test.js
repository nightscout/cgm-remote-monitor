'use strict';

require('should');

const security = require('../lib/api3/security')
  , updateOperation = require('../lib/api3/generic/update/operation')
  ;

describe('API3 UPDATE operation authorization ordering', function () {
  let originalAuthenticate;
  let originalConsoleError;

  beforeEach(function () {
    originalAuthenticate = security.authenticate;
    originalConsoleError = console.error;
    console.error = function () {};
  });

  afterEach(function () {
    security.authenticate = originalAuthenticate;
    console.error = originalConsoleError;
  });

  it('rejects callers without write authorization before processing or querying', async function () {
    const observed = {
      parseCalls: 0,
      filterCalls: 0,
      findCalls: 0
    };
    security.authenticate = async function () {
      return authWith('api:settings:read');
    };

    const handler = updateOperation({}, {}, {}, createCollection(observed));
    const res = createResponse();

    await handler({
      body: validDocument(),
      params: { identifier: 'record-1' }
    }, res);

    res.statusCode.should.equal(403);
    res.body.message.should.equal('Missing permission api:settings:update');
    observed.parseCalls.should.equal(0);
    observed.filterCalls.should.equal(0);
    observed.findCalls.should.equal(0);
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
    identifier: 'record-1',
    date: Date.now(),
    utcOffset: 0,
    app: 'api3-update-security-test'
  };
}

function createCollection (observed) {
  return {
    colName: 'settings',
    parseDate: function () {
      observed.parseCalls += 1;
    },
    storage: {
      identifyingFilter: function () {
        observed.filterCalls += 1;
        return {};
      },
      findOneFilter: async function () {
        observed.findCalls += 1;
        return [];
      }
    }
  };
}

function createResponse () {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
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
