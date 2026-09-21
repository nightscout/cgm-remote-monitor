'use strict';

// Supertest binds an unspecified address but always requests IPv4 loopback.
// An IPv6 listener can share a port with an unrelated IPv4 listener. Match the
// URL to the fixture's family rather than sending the request to that listener.
const {Test} = require('supertest');
const installed = Symbol.for('nightscout.supertest.loopback');
if (!Test.prototype[installed]) {
  const serverAddress = Test.prototype.serverAddress;
  Test.prototype.serverAddress = function (app, path) {
    const target = serverAddress.call(this, app, path);
    const address = app.address();
    if (address && address.family === 'IPv6' && address.address === '::') {
      const url = new URL(target);
      url.hostname = '[::1]';
      return url.href;
    }
    return target;
  };
  Object.defineProperty(Test.prototype, installed, {value: true});
}
