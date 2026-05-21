'use strict';

const path = require('path');
const should = require('should');

describe('tests/fixtures/benv-shim', function () {

  // Ensure each test gets a clean room
  let benv;
  beforeEach(function () {
    delete require.cache[require.resolve('./benv-shim')];
    benv = require('./benv-shim');
  });
  afterEach(function () {
    benv.teardown(true);
  });

  it('setup() exposes window/document on global', function (done) {
    benv.setup(function () {
      should.exist(global.window);
      should.exist(global.document);
      should.exist(global.navigator);
      done();
    });
  });

  it('expose() pushes values onto window and global', function (done) {
    benv.setup(function () {
      benv.expose({ FOOBAR: 42 });
      global.FOOBAR.should.equal(42);
      global.window.FOOBAR.should.equal(42);
      done();
    });
  });

  it('teardown() removes exposed keys but keeps DOM by default', function (done) {
    benv.setup(function () {
      benv.expose({ TRANSIENT: 'x' });
      benv.teardown();
      should.not.exist(global.TRANSIENT);
      should.exist(global.window);   // teardown(false) keeps window
      done();
    });
  });

  it('teardown(true) removes the DOM globals', function (done) {
    benv.setup(function () {
      benv.teardown(true);
      should.not.exist(global.window);
      should.not.exist(global.document);
      done();
    });
  });

  it('require() loads an absolute path and runs it against the shim window', function (done) {
    benv.setup(function () {
      const fixturePath = path.join(__dirname, 'benv-shim.fixture-module.js');
      const mod = benv.require(fixturePath);
      // The fixture module sets window.SHIMTEST = 'ok' at top level
      global.window.SHIMTEST.should.equal('ok');
      should.exist(mod);
      done();
    });
  });

  it('require() rejects relative paths with a clear error', function (done) {
    benv.setup(function () {
      (function () { benv.require('./nope.js'); })
        .should.throw(/absolute path/);
      done();
    });
  });

});
