'use strict';

const should = require('should');
const { createSecureDOM, NoNetworkLoader } = require('./secure-jsdom');

describe('tests/fixtures/secure-jsdom', function () {

  let env;

  afterEach(function () {
    if (env && env.cleanup) env.cleanup();
    env = null;
  });

  it('boots a usable DOM', function () {
    env = createSecureDOM('<!DOCTYPE html><html><body><div id="x">hi</div></body></html>');
    should.exist(env.window);
    should.exist(env.document);
    env.document.getElementById('x').textContent.should.equal('hi');
  });

  it('blocks window.fetch', function () {
    env = createSecureDOM();
    (function () { env.window.fetch('http://example.com/'); })
      .should.throw(/disabled/);
  });

  it('blocks XMLHttpRequest.send', function () {
    env = createSecureDOM();
    const XHR = env.window.XMLHttpRequest;
    should.exist(XHR);
    const xhr = new XHR();
    xhr.open('GET', 'http://example.com/');
    (function () { xhr.send(); }).should.throw(/disabled/);
  });

  it('NoNetworkLoader rejects network fetches', function () {
    const loader = new NoNetworkLoader();
    return loader.fetch('http://example.com/').then(
      function () { throw new Error('should not resolve'); },
      function (err) { err.message.should.match(/network access blocked/); }
    );
  });

});
