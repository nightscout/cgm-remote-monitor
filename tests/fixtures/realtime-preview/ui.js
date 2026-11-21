'use strict';
// Controlled browser reference fixture, NOT a product API UI mount. Uses actual
// unchanged page, production browser bundle and startup/client assets. No build.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
module.exports = async function ui ({ sourceDir, bundleDirectory, settings, expectedBundleSha256 }) {
  const bundle = path.join(bundleDirectory, 'js/bundle.app.js');
  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
  assert.equal(digest, expectedBundleSha256, 'root frozen same-head bundle identity required');
  const filename = path.join(sourceDir, 'views/index.html');
  const html = await require('ejs').renderFile(filename, { type: 'index', title: '', settings,
    locals: { bundle: '/bundle', cachebuster: 'owned-native-fixture', mode: 'production' } });
  const app = require('express')();
  app.get('/', (req, res) => res.type('html').send(html));
  app.use('/bundle', require('express').static(bundleDirectory, { fallthrough: true }));
  app.use(require('express').static(path.join(sourceDir, 'static'), { fallthrough: true }));
  return app;
};
