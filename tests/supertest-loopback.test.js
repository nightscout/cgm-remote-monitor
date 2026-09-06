'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
require('./lib/supertest-loopback');
const request = require('supertest');

describe('Supertest fixture address family', function () {
  it('reaches the intended IPv6 fixture when IPv4 has the same port', async function () {
    let wrongRequests = 0;
    const other = http.createServer((req, res) => {wrongRequests++; res.statusCode = 405; res.end('wrong fixture');});
    const intended = http.createServer((req, res) => res.end('intended fixture'));
    try {
      other.listen(0, '127.0.0.1'); await once(other, 'listening');
      intended.listen({port: other.address().port, host: '::', ipv6Only: true});
      await once(intended, 'listening');
      for (let cycle = 0; cycle < 2; cycle++) {
        const response = await request(intended).get('/').expect(200);
        assert.equal(response.text, 'intended fixture');
      }
      assert.equal(wrongRequests, 0);
    } finally {
      await Promise.all([other, intended].map(server => new Promise(resolve => server.close(resolve))));
    }
  });
  it('retains IPv4 URLs for explicitly bound IPv4 fixtures', async function () {
    const server = http.createServer((req, res) => res.end('ipv4'));
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const test = request(server).get('/');
      assert.equal(new URL(test.url).hostname, '127.0.0.1');
      assert.equal((await test.expect(200)).text, 'ipv4');
    } finally {await new Promise(resolve => server.close(resolve));}
  });
});
