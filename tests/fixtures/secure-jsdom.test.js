'use strict';

const should = require('should');
const { createSecureDOM } = require('./secure-jsdom');
const assert = require('assert');
const http = require('http');
const {once} = require('events');
const {VirtualConsole} = require('jsdom');

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

  it('blocks actual stylesheet, iframe and script loads over repeated DOM lifecycles', async function () {
    let requests = 0;
    const server = http.createServer((req, res) => { requests++; res.end('unexpected request'); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const errors = [];
        const virtualConsole = new VirtualConsole();
        virtualConsole.on('jsdomError', error => errors.push(error));
        env = createSecureDOM('<link rel="stylesheet" href="/fixture.css"><iframe src="/fixture.html"></iframe><script src="/fixture.js"></script>', {
          url: origin, runScripts: 'dangerously', virtualConsole
        });
        if (env.document.readyState !== 'complete') await once(env.window, 'load');
        assert.strictEqual(requests, 0);
        assert.strictEqual(errors.length, 3, 'every attempted resource load is rejected');
        assert.ok(errors.every(error => String(error.cause || error.detail).includes('network access blocked')));
        env.cleanup();
        env = null;
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('blocks WebSocket handshakes without contacting the fixture server', async function () {
    let requests = 0;
    const server = http.createServer((req, res) => { requests++; res.end(); });
    server.on('upgrade', (req, socket) => { requests++; socket.destroy(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        env = createSecureDOM();
        const socket = new env.window.WebSocket('ws://127.0.0.1:' + server.address().port);
        await once(socket, 'error');
        assert.strictEqual(requests, 0);
        env.cleanup();
        env = null;
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

});
