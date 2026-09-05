'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const {getBrowser} = require('./hooks');

describe('Browser fixture isolation', function () {
  let allowed, denied, origin, outside, received;
  before(async function () {
    received = [];
    denied = http.createServer((request, response) => {
      received.push(request.url);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end('outside fixture');
    });
    denied.on('upgrade', (request, socket) => {
      received.push(request.url);
      socket.destroy();
    });
    denied.listen(0, '127.0.0.1');
    await once(denied, 'listening');
    outside = 'http://127.0.0.1:' + denied.address().port;
    allowed = http.createServer((request, response) => {
      if (request.url === '/worker.js') {
        response.setHeader('Content-Type', 'application/javascript');
        response.end('onmessage = async event => { try { await fetch(event.data); postMessage("allowed"); } catch { postMessage("blocked"); } };');
      } else if (request.url === '/redirect') {
        response.writeHead(302, {location: outside + '/redirect-target'});
        response.end();
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body></body></html>');
      }
    });
    allowed.listen(0, '127.0.0.1');
    await once(allowed, 'listening');
    origin = 'http://127.0.0.1:' + allowed.address().port;
  });
  after(async function () {
    await Promise.all([allowed, denied].filter(Boolean).map(server => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    })));
  });

  it('blocks fetch, XHR, subresources, redirects and WebSockets outside the fixture twice', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      await withPage(origin, async ({page, blocked}) => {
        await page.goto(origin);
        await page.evaluate(async outside => {
          const completed = [];
          completed.push(fetch(outside + '/fetch').catch(() => {}));
          completed.push(fetch('/redirect').catch(() => {}));
          completed.push(new Promise((resolve, reject) => {
            const worker = new Worker('/worker.js');
            worker.onmessage = event => {
              worker.terminate();
              event.data === 'blocked' ? resolve() : reject(new Error('Worker escaped fixture'));
            };
            worker.onerror = reject;
            worker.postMessage(outside + '/worker-fetch');
          }));
          completed.push(new Promise(resolve => {
            const xhr = new XMLHttpRequest();
            xhr.onloadend = resolve;
            xhr.open('GET', outside + '/xhr');
            xhr.send();
          }));
          completed.push(new Promise(resolve => {
            const socket = new WebSocket(outside.replace('http:', 'ws:') + '/socket');
            socket.onclose = resolve;
            socket.onerror = resolve;
          }));
          for (const [tag, attribute, pathname] of [
            ['script', 'src', '/script.js'], ['img', 'src', '/image.png'],
            ['link', 'href', '/style.css'], ['iframe', 'src', '/frame']
          ]) {
            const element = document.createElement(tag);
            if (tag === 'link') element.rel = 'stylesheet';
            element[attribute] = outside + pathname;
            document.body.appendChild(element);
          }
          await Promise.all(completed);
        }, outside);
        // Wait for all subresource interception callbacks, without allowing a
        // successful request to count as a completed isolation assertion.
        const expected = ['/fetch', '/xhr', '/socket', '/script.js', '/image.png', '/style.css', '/frame', '/redirect-target', '/worker-fetch'];
        const deadline = Date.now() + 3000;
        while (expected.some(path => !blocked.some(url => new URL(url).pathname === path)) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.deepEqual(new Set(blocked.map(url => new URL(url).pathname)), new Set(expected));
        assert.deepEqual(received, [], 'Blocked server received a request or WebSocket handshake');
      }, {expectBlocked: true});
    }
  });

  it('uses fresh storage and blocks service workers across two lifecycles', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      await withPage(origin, async ({page, context}) => {
        await page.goto(origin);
        assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
        await page.evaluate(() => {
          localStorage.setItem('token', 'fixture');
          sessionStorage.setItem('state', 'fixture');
          document.cookie = 'fixture=value';
        });
        await page.evaluate(() => navigator.serviceWorker.register('/sw.js').catch(() => {}));
        assert.equal(context.serviceWorkers().length, 0);
      });
      assert.equal(getBrowser().contexts().length, 0);
    }
  });

  it('closes every page and context after a test failure twice', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      let page;
      await assert.rejects(withPage(origin, async fixture => {
        page = fixture.page;
        await page.goto(origin);
        await fixture.context.newPage();
        throw new Error('deliberate fixture failure');
      }), /deliberate fixture failure/);
      assert.equal(page.isClosed(), true);
      assert.equal(getBrowser().contexts().length, 0);
    }
  });
});
