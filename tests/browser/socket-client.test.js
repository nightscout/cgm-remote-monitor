'use strict';
/* global fixture, socket */

const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {Server} = require('socket.io');
const {withPage} = require('./fixture');

describe('Served Socket.IO client in a real browser', function () {
  let io, origin;
  beforeEach(async function () {
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    });
    io = new Server(server, {allowEIO3: true, perMessageDeflate: {threshold: 512}, httpCompression: {threshold: 512}});
    io.on('connection', peer => {
      peer.on('echo', (data, acknowledge) => acknowledge(data));
      peer.on('snapshot', acknowledge => {
        peer.emit('dataUpdate', {sgvs: [{sgv: 123}], treatments: [{notes: 'Fish & Chips'}]});
        acknowledge({ok: true});
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  afterEach(async function () {
    if (io) await new Promise(resolve => io.close(resolve));
  });

  async function prepare(page) {
    await page.goto(origin);
    await page.addScriptTag({url: origin + '/socket.io/socket.io.js'});
    await page.evaluate(() => {
      window.fixture = {
        event(emitter, name) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { emitter.off(name, finish); reject(new Error(name + ' timed out')); }, 3000);
            function finish(...args) { clearTimeout(timer); resolve(args); }
            emitter.once(name, finish);
          });
        },
        acknowledge(socket, event, ...args) {
          return new Promise((resolve, reject) => {
            socket.timeout(3000).emit(event, ...args, (error, reply) => error ? reject(error) : resolve(reply));
          });
        }
      };
    });
  }

  for (const transport of ['polling', 'websocket', 'upgrade']) {
    it('preserves updates, large messages and binary acknowledgements across two reconnects over ' + transport, async function () {
      await withPage(origin, async ({page}) => {
        await prepare(page);
        const results = await page.evaluate(async ({origin, transport}) => {
          const socket = window.io(origin, {autoConnect: false, forceNew: true, reconnection: false,
            transports: transport === 'upgrade' ? ['polling', 'websocket'] : [transport]});
          const results = [];
          try {
            for (let cycle = 0; cycle < 3; cycle++) {
              const connected = fixture.event(socket, 'connect');
              socket.connect();
              await connected;
              if (transport === 'upgrade' && socket.io.engine.transport.name !== 'websocket') await fixture.event(socket.io.engine, 'upgrade');
              const update = fixture.event(socket, 'dataUpdate');
              const snapshot = await fixture.acknowledge(socket, 'snapshot');
              const received = (await update)[0];
              const large = {notes: 'Café 💉'.repeat(2048)};
              const largeReply = await fixture.acknowledge(socket, 'echo', large);
              const reply = await fixture.acknowledge(socket, 'echo', {notes: 'Café 💉', binary: new Uint8Array([0, 127, 255])});
              results.push({transport: socket.io.engine.transport.name, snapshot, received,
                largeMatches: largeReply.notes === large.notes, notes: reply.notes, binary: Array.from(new Uint8Array(reply.binary))});
              socket.disconnect();
            }
          } finally { socket.disconnect(); }
          return results;
        }, {origin, transport});
        assert.equal(results.length, 3);
        for (const result of results) {
          assert.deepEqual(result, {transport: transport === 'upgrade' ? 'websocket' : transport,
            snapshot: {ok: true}, received: {sgvs: [{sgv: 123}], treatments: [{notes: 'Fish & Chips'}]},
            largeMatches: true, notes: 'Café 💉', binary: [0, 127, 255]});
        }
      });
    });
  }

  it('automatically reconnects and resumes updates after two network drops without duplicate peers', async function () {
    await withPage(origin, async ({page}) => {
      await prepare(page);
      await page.evaluate(async origin => {
        window.socket = window.io(origin, {autoConnect: false, forceNew: true, reconnectionDelay: 10,
          reconnectionDelayMax: 20, randomizationFactor: 0, transports: ['polling', 'websocket']});
        const connected = fixture.event(socket, 'connect');
        socket.connect();
        await connected;
      }, origin);
      try {
        for (let cycle = 0; cycle < 2; cycle++) {
          const result = await page.evaluate(async () => {
            const reconnected = fixture.event(socket, 'connect');
            socket.io.engine.close();
            await reconnected;
            const update = fixture.event(socket, 'dataUpdate');
            const reply = await fixture.acknowledge(socket, 'snapshot');
            return {reply, update: (await update)[0]};
          });
          assert.equal(result.reply.ok, true);
          assert.equal(result.update.sgvs[0].sgv, 123);
          assert.equal(io.of('/').sockets.size, 1);
        }
      } finally { await page.evaluate(() => socket.disconnect()); }
    });
  });
});
