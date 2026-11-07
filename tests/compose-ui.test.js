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
