'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const {gunzipSync} = require('node:zlib');
const {createPageFixture} = require('./fixtures/page-startup/server');

describe('Page benchmark HTTP body accounting', function () {
  it('counts actual compressed and identity bytes once at the final response write', async function () {
    const fixture = await createPageFixture({compress: true, measureTraffic: true});
    try {
      for (const encoding of ['gzip', 'identity']) {
        const result = await new Promise((resolve, reject) => {
          const request = http.get(fixture.origin + '/bundle/js/bundle.app.js', {headers: {'Accept-Encoding': encoding}}, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => resolve({bytes: Buffer.concat(chunks), headers: response.headers}));
          });
          request.on('error', reject);
          request.setTimeout(3000, () => request.destroy(new Error('Owned asset response timed out')));
        });
        const record = fixture.state.traffic.at(-1);
        assert.equal(record.completed, true);
        assert.equal(record.bodyBytes, result.bytes.length, 'Instrumented bytes match the actual HTTP response body');
        assert.equal(record.encoding, encoding);
        assert.equal(result.headers['content-encoding'] || 'identity', encoding);
        if (encoding === 'gzip') assert.ok(gunzipSync(result.bytes).length > result.bytes.length, 'Measure compressed bytes, not source bytes');
      }
    } finally {await new Promise(resolve => fixture.io.close(resolve));}
  });
});
