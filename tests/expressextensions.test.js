'use strict';

require('should');

var extensionsMiddleware = require('../lib/middleware/express-extension-to-accept.js');

var acceptJsonRequests = extensionsMiddleware(['json']);

describe('Express extension middleware', function ( ) {

  it('Valid json request should be given accept header for application/json', function () {
    var entriesRequest = {
      path: '/api/v1/entries.json',
      url: '/api/v1/entries.json',
      headers: {}
    };

    acceptJsonRequests(entriesRequest, {}, () => {});
    entriesRequest.headers.accept.should.equal('application/json');
  });

  it('Invalid json request should NOT be given accept header', function () {
    var invalidEntriesRequest = {
      path: '/api/v1/entriesXjson',
      url: '/api/v1/entriesXjson',
      headers: {}
    };

    acceptJsonRequests(invalidEntriesRequest, {}, () => {});
    should(invalidEntriesRequest.headers.accept).not.be.ok;
  });

});
