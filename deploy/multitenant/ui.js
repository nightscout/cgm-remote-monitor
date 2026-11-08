'use strict';

// DB-less rendering of the shipped browser pages. This public projection selects
// HTML presentation only; the unchanged client obtains authority, settings and
// clinical data from the API/realtime roles on the same public origin.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '../..');
const PAGES = Object.freeze({
  '/': { file: 'index.html', type: 'index', title: '' },
  '/food': { file: 'foodindex.html', type: 'food', title: 'Food Editor' },
  '/profile': { file: 'profileindex.html', type: 'profile', title: 'Profile Editor' },
  '/report': { file: 'reportindex.html', type: 'report', title: 'Nightscout reporting' }
});
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  names.every(name => Object.hasOwn(value, name)) && Object.keys(value).every(name => names.includes(name));

function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase() ||
      !value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new TypeError('UI_PUBLIC_HOST_INVALID');
  }
  return value;
}

function parseConfig(value) {
  if (!exact(value, ['version', 'tenants']) || value.version !== 1 ||
      !Array.isArray(value.tenants) || !value.tenants.length || value.tenants.length > 1000) {
    throw new TypeError('UI_PUBLIC_CONFIG_INVALID');
  }
  const hosts = new Map();
  for (const tenant of value.tenants) {
    if (!exact(tenant, ['aliases', 'theme']) || !['default', 'modern'].includes(tenant.theme) ||
        !Array.isArray(tenant.aliases) || !tenant.aliases.length || tenant.aliases.length > 100) {
      throw new TypeError('UI_PUBLIC_CONFIG_INVALID');
    }
    for (const alias of tenant.aliases) {
      hostname(alias);
      if (hosts.has(alias)) throw new TypeError('UI_PUBLIC_HOST_DUPLICATE');
      hosts.set(alias, Object.freeze({ theme: tenant.theme }));
    }
  }
  return hosts;
}

function requestHost(value) {
  if (typeof value !== 'string') return null;
  const match = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match || match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return null;
  try { return hostname(match[1].toLowerCase()); } catch { return null; }
}

function createApp({ config, root = ROOT } = {}) {
  const hosts = parseConfig(config);
  const express = require('express');
  const ejs = require('ejs');
  const app = express();
  const bundleDirectory = path.join(root, 'node_modules/.cache/_ns_cache/public');
  // A deployment must build this checkout's real production browser bundle.
  // Missing artifacts refuse startup rather than serving a fixture/fallback UI.
  for (const name of ['app', 'clock', 'food', 'profile', 'reports']) {
    const filename = path.join(bundleDirectory, 'js/bundle.' + name + '.js');
    if (!fs.statSync(filename).isFile()) throw new Error('UI_PRODUCTION_BUNDLE_REQUIRED');
  }
  const cachebuster = crypto.createHash('sha256').update(fs.readFileSync(path.join(bundleDirectory, 'js/bundle.app.js'))).digest('hex');
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(require('../../lib/middleware/credential-cache'));
  app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();
    next();
  });
  // Private container health probe contains no tenant or credential information.
  app.get('/healthz', (req, res) => res.type('text/plain').send('ok\n'));
  app.use((req, res, next) => {
    req.publicPresentation = hosts.get(requestHost(req.headers.host));
    if (!req.publicPresentation) return res.status(421).end();
    next();
  });
  const locals = Object.freeze({ bundle: '/bundle', mode: 'production', cachebuster });
  for (const [route, page] of Object.entries(PAGES)) {
    app.get(route, async (req, res, next) => {
      try {
        const html = await ejs.renderFile(path.join(root, 'views', page.file), {
          ...page, locals, settings: req.publicPresentation
        });
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
      } catch (error) { next(error); }
    });
  }
  const worker = fs.readFileSync(path.join(root, 'views/service-worker.js'), 'utf8');
  app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').send(ejs.render(worker, { locals }));
  });
  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  const assets = { dotfiles: 'deny', index: false, redirect: false, maxAge: '7d', fallthrough: true };
  app.use('/bundle', express.static(bundleDirectory, assets));
  app.use('/translations', express.static(path.join(root, 'translations'), assets));
  app.use(express.static(path.join(root, 'static'), assets));
  app.use((req, res) => res.status(404).end());
  // Do not log request URLs (legacy links may carry credentials) or source paths.
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) return res.destroy();
    res.status(500).type('text/plain').send('UI unavailable\n');
  });
  return app;
}

function main(env = process.env) {
  if (!env.UI_PUBLIC_CONFIG) throw new Error('UI_PUBLIC_CONFIG_REQUIRED');
  const bytes = fs.readFileSync(env.UI_PUBLIC_CONFIG);
  if (bytes.length > 1048576) throw new Error('UI_PUBLIC_CONFIG_TOO_LARGE');
  const app = createApp({ config: JSON.parse(bytes.toString('utf8')) });
  const port = env.UI_PORT === undefined ? 1340 : Number(env.UI_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('UI_PORT_INVALID');
  const server = app.listen(port, env.UI_HOSTNAME || '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
  return server;
}
if (require.main === module) {
  try { main(); } catch { process.stderr.write('UI_STARTUP_REFUSED\n'); process.exitCode = 78; }
}
module.exports = { parseConfig, requestHost, createApp, main, PAGES };
