'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../deploy/multitenant/ui');
const { Readable } = require('node:stream');
const { ServerResponse } = require('node:http');

// Exercise the real Express application without opening a listener or service.
function request(app, host, url = '/') {
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() { this.push(null); } });
    req.method = 'GET'; req.url = url; req.headers = { host }; req.socket = {};
    const res = new ServerResponse(req);
    res.end = data => { resolve({ status: res.statusCode, headers: res.getHeaders(), body: String(data || '') }); return res; };
    app.handle(req, res, reject);
  });
}

const config = () => ({ version: 1, tenants: [
  { aliases: ['one.example.test'], theme: 'default' },
  { aliases: ['two.example.test'], theme: 'modern' }
] });

describe('multitenant deployment UI public boundary', function () {
  it('selects each public alias without mixing tenant presentation', function () {
    const hosts = ui.parseConfig(config());
    assert.equal(hosts.get(ui.requestHost('ONE.EXAMPLE.TEST:8080')).theme, 'default');
    assert.equal(hosts.get(ui.requestHost('two.example.test')).theme, 'modern');
    assert.equal(hosts.has(ui.requestHost('foreign.example.test')), false);
    assert.equal(Object.isFrozen(hosts.get('one.example.test')), true);
  });

  it('rejects ambiguous selectors and sensitive configuration instead of publishing it', function () {
    const duplicate = config(); duplicate.tenants[1].aliases.push('one.example.test');
    assert.throws(() => ui.parseConfig(duplicate), /UI_PUBLIC_HOST_DUPLICATE/);
    for (const key of ['credentials', 'tenant', 'rootSecret', 'connectionString']) {
      const sensitive = config(); sensitive.tenants[0][key] = 'synthetic-private-canary';
      assert.throws(() => ui.parseConfig(sensitive), /UI_PUBLIC_CONFIG_INVALID/);
    }
    const injected = config(); injected.tenants[0].theme = '<script>canary</script>';
    assert.throws(() => ui.parseConfig(injected), /UI_PUBLIC_CONFIG_INVALID/);
  });

  it('refuses malformed Host authority rather than interpreting proxy or URL syntax', function () {
    for (const value of ['one.example.test@evil.test', 'one.example.test/other',
      'one.example.test:65536', 'one.example.test:0', 'one..example.test',
      'one.example.test, two.example.test', 'one.example.test\r\nX-Internal-Name: other', undefined]) {
      assert.equal(ui.requestHost(value), null);
    }
  });

  it('routes actual page rendering by public host and refuses unknown tenants without a listener', async function () {
    const app = ui.createApp({ config: config() });
    const first = await request(app, 'one.example.test:8080');
    const second = await request(app, 'two.example.test:8080');
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert(!first.body.includes('<html class="modern-ui">'));
    assert(second.body.includes('<html class="modern-ui">'));
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.headers['referrer-policy'], 'no-referrer');
    assert.equal((await request(app, 'foreign.example.test')).status, 421);
    assert.equal((await request(app, 'one.example.test', '/admin')).status, 404);
  });

  it('renders the actual shipped pages and retains same-origin scripts and existing authentication UI', async function () {
    const ejs = require('ejs');
    for (const [route, page] of Object.entries(ui.PAGES)) {
      const html = await ejs.renderFile(path.resolve(__dirname, '../views', page.file), {
        ...page, locals: { bundle: '/bundle', mode: 'production', cachebuster: 'source-render' },
        settings: { theme: 'default' }
      });
      assert.match(html, /\/bundle\/js\/bundle\.app\.js/);
      assert.match(html, /src="\/socket\.io\/socket\.io\.js"/);
      assert(!html.includes('synthetic-private-canary'), route);
    }
    const dashboard = fs.readFileSync(path.resolve(__dirname, '../views/index.html'), 'utf8');
    assert.match(dashboard, /authentication-status/);
    assert.equal(Object.hasOwn(ui.PAGES, '/admin'), false);
  });
});

describe('Compose ui startup refusal names its cause', function () {
  this.timeout(20000);
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  let dir;
  before(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ui-refusal-')); });
  after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  // The actual entrypoint, as the container runs it (exit 78 and one stderr line).
  function start (text, extra = {}) {
    const file = path.join(dir, 'ui.json'); fs.writeFileSync(file, text);
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../deploy/multitenant/ui.js')],
      { env: { PATH: process.env.PATH, UI_PUBLIC_CONFIG: file, UI_PORT: '1', ...extra }, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  }
  const tenants = n => JSON.stringify({ version: 1, tenants: Array.from({ length: n }, (_, i) => ({ aliases: ['t' + i + '.example.test'], theme: 'default' })) });

  it('prints the bounded reader code and message, without the configuration contents', function () {
    const marker = 'SYNTHETIC_UI_MARKER';
    const big = start(JSON.stringify({ version: 1, pad: marker + 'x'.repeat(1048576) }));
    assert.equal(big.status, 78);
    assert.match(big.stderr, /^UI_STARTUP_REFUSED: CONFIG_FILE_TOO_LARGE: UI_PUBLIC_CONFIG is too large: \d+ bytes, over the limit of 1048576 bytes \(MULTITENANT_CONFIG_MAX_BYTES\)\n$/, 'UI_CAUSE_CODE_PRINTED');
    const bad = start('{"' + marker + '": ');
    assert.equal(bad.stderr, 'UI_STARTUP_REFUSED: CONFIG_FILE_INVALID_JSON: UI_PUBLIC_CONFIG is not valid JSON\n');
    for (const result of [big, bad]) assert.ok(!result.stderr.includes(marker));
  });

  it('prints the ui configuration code for a refused roster', function () {
    assert.equal(start(JSON.stringify({ version: 2, tenants: [] })).stderr, 'UI_STARTUP_REFUSED: UI_PUBLIC_CONFIG_INVALID\n');
    // One over the preview's tenant ceiling, inside a raised byte bound: refused for its count.
    assert.equal(start(tenants(10001), { MULTITENANT_CONFIG_MAX_BYTES: '4194304' }).stderr, 'UI_STARTUP_REFUSED: UI_PUBLIC_CONFIG_INVALID\n');
  });

  it('accepts up to the preview tenant ceiling, the same constant as the admin roster', function () {
    const { PREVIEW_MAX_TENANTS } = require('../lib/server/serve/tenant-ceiling');
    assert.equal(PREVIEW_MAX_TENANTS, 10000);
    const roster = n => ({ version: 1, tenants: Array.from({ length: n }, (_, i) => ({ aliases: ['t' + i + '.example.test'], theme: i % 2 ? 'modern' : 'default' })) });
    assert.equal(ui.parseConfig(roster(3000)).size, 3000, 'UI_3000_TENANTS_ACCEPTED');
    assert.equal(ui.parseConfig(roster(PREVIEW_MAX_TENANTS)).size, PREVIEW_MAX_TENANTS);
    assert.throws(() => ui.parseConfig(roster(PREVIEW_MAX_TENANTS + 1)), /^TypeError: UI_PUBLIC_CONFIG_INVALID$/);
  });

  it('starts the actual entrypoint on a 3,000-tenant configuration and serves its hosts', async function () {
    const net = require('node:net');
    const http = require('node:http');
    const { spawn } = require('node:child_process');
    const port = await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); }); });
    const file = path.join(dir, 'ui-3000.json'); fs.writeFileSync(file, tenants(3000));
    const child = spawn(process.execPath, [path.resolve(__dirname, '../deploy/multitenant/ui.js')],
      { env: { PATH: process.env.PATH, UI_PUBLIC_CONFIG: file, UI_PORT: String(port), UI_HOSTNAME: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const get = host => new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: '/robots.txt', headers: { host } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(null));
    });
    try {
      let status = null;
      for (let i = 0; i < 100 && status === null && child.exitCode === null; i++) {
        status = await get('t2999.example.test');
        if (status === null) await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(status, 200, 'UI_3000_TENANTS_SERVED; stderr: ' + stderr);
      assert.equal(await get('t3000.example.test'), 421, 'an unconfigured host is refused');
    } finally { child.kill('SIGTERM'); }
  });
});
