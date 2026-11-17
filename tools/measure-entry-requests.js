'use strict';

// Matched owned-fixture HTTP measurements; no deployment or MongoDB access.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const {once} = require('node:events');
const {Session} = require('node:inspector');
const {spawnSync} = require('node:child_process');
const createFixture = require('../tests/fixtures/entry-transforms');

async function sample(root, count, operation) {
  assert.ok(global.gc, 'Run child samples with --expose-gc');
  const rows = Array.from({length: count}, (_, i) => ({date: 1735682400000 + i * 300000, type: 'sgv', sgv: 100 + i % 20}));
  const {app, state} = createFixture(rows, false, root);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const agent = new http.Agent({keepAlive: true, maxSockets: 1});
  const body = Buffer.from(JSON.stringify(rows));
  async function request() {
    return new Promise((resolve, reject) => {
      const post = operation !== 'get';
      const req = http.request({host: '127.0.0.1', port: server.address().port, agent,
        method: post ? 'POST' : 'GET', path: post ? '/entries/' + (operation === 'preview' ? 'preview' : '') : '/entries/sgv?find[date][$gte]=0&count=' + count,
        headers: {Accept: 'application/json', ...(post ? {'Content-Type': 'application/json', 'Content-Length': body.length} : {})}}, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            const buffer = Buffer.concat(chunks), values = JSON.parse(buffer);
            assert.equal(values.length, count);
            assert.equal(values[0].date, rows[operation === 'get' ? count - 1 : 0].date);
            assert.equal(state.writes.length, operation === 'write' ? 1 : 0);
            state.writes.length = 0; // Do not retain the fake collection's history.
            resolve(buffer.length);
          } catch (error) {reject(error);}
        });
      });
      req.on('error', reject); req.end(post ? body : undefined);
    });
  }
  try {
    for (let i = 0; i < 5; i++) await request();
    global.gc(); const before = process.memoryUsage().heapUsed;
    const start = performance.now(); let bytes;
    for (let i = 0; i < 30; i++) bytes = await request();
    const duration = performance.now() - start;
    const beforeGC = process.memoryUsage().heapUsed;
    global.gc(); const retained = process.memoryUsage().heapUsed;
    // Profile separately so allocation sampling does not distort the timing
    // phase. Include collected objects, rather than only surviving allocations.
    const session = new Session(); session.connect();
    const post = (method, params) => new Promise((resolve, reject) => session.post(method, params || {}, (error, result) => error ? reject(error) : resolve(result)));
    let allocation;
    try {
      await post('HeapProfiler.startSampling', {samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true});
      for (let i = 0; i < 30; i++) await request();
      const {profile} = await post('HeapProfiler.stopSampling');
      const total = (node, inEntries = false) => {
        const attributed = inEntries || /\/lib\/(?:api\/entries\/index|server\/entries)\.js$/.test(node.callFrame.url);
        const result = {estimatedBytes: node.selfSize, entryAttributedBytes: attributed ? node.selfSize : 0};
        for (const child of node.children) {
          const childResult = total(child, attributed);
          result.estimatedBytes += childResult.estimatedBytes; result.entryAttributedBytes += childResult.entryAttributedBytes;
        }
        return result;
      };
      allocation = total(profile.head);
    } finally {session.disconnect();}
    return {count, operation, requests: 30, meanMs: duration / 30, responseBytes: bytes, allocation,
      heapBefore: before, heapBeforeGC: beforeGC, heapAfterGC: retained};
  } finally {agent.destroy(); await new Promise(resolve => server.close(resolve));}
}

async function main() {
  if (process.argv[2] === '--sample') {
    const result = await sample(path.resolve(process.argv[3]), Number(process.argv[4]), process.argv[5]);
    console.log(JSON.stringify(result)); return;
  }
  assert.ok(process.argv[2], 'Usage: node tools/measure-entry-requests.js PARENT_CHECKOUT');
  const roots = {parent: path.resolve(process.argv[2]), candidate: path.resolve(__dirname, '..')};
  const rows = [];
  for (let run = 0; run < 7; run++) for (const operation of ['get', 'preview', 'write']) {
    for (const label of run % 2 ? ['candidate', 'parent'] : ['parent', 'candidate']) {
      process.stderr.write(run + ' ' + operation + ' ' + label + '\n');
      const child = spawnSync(process.execPath, ['--expose-gc', __filename, '--sample', roots[label], '1000', operation], {encoding: 'utf8', timeout: 60000});
      assert.equal(child.status, 0, child.stderr || child.error?.message);
      rows.push({run, label, ...JSON.parse(child.stdout.trim())});
    }
  }
  console.log(JSON.stringify({node: process.versions.node, scenario: 'owned real router, fake collection, 1000 entries, fresh process per sample, 5 warmups, 30 timed HTTP requests, then 30 separately allocation-profiled requests', rows}, null, 2));
}
if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
