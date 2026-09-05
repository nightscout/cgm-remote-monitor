'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {fork} = require('node:child_process');
const express = require('express');
const ejs = require('ejs');
const {withPage} = require('./fixture');
const root = path.resolve(__dirname, '../..');
const imagePath = '/images/7342f65db5b9bb9b02700ef08b4ef27c.png';

async function serve(directory, prefix, run) {
  const app = express(), requests = [];
  app.get('/', (request, response) => response.type('html').send('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="toolbar">Fixture</div></body></html>'));
  app.use((request, response, next) => {requests.push(request.path); next();});
  app.use(prefix, express.static(directory));
  app.use(express.static(path.join(root, 'static')));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {await withPage(origin, ({page}) => run(page, origin, requests));}
  finally {await new Promise(resolve => server.close(resolve));}
}

async function assertImage(page, origin, prefix) {
  const expected = origin + prefix + imagePath;
  assert.equal(await page.locator('#toolbar').evaluate(node => getComputedStyle(node).backgroundImage), 'url("' + expected + '")');
  const dimensions = await page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, expected);
  const png = fs.readFileSync(path.join(root, 'static/images/logo2.png'));
  assert.deepEqual(dimensions, [png.readUInt32BE(16), png.readUInt32BE(20)]);
}

function response(worker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Asset compiler response timed out')), 20000);
    const onExit = code => finish(new Error('Asset compiler exited: ' + code));
    const onError = error => finish(error);
    const onMessage = message => finish(message.error ? new Error(message.error) : null, message);
    function finish(error, value) {
      clearTimeout(timer); worker.off('exit', onExit); worker.off('message', onMessage); worker.off('error', onError);
      if (error) reject(error); else resolve(value);
    }
    worker.once('exit', onExit); worker.once('message', onMessage); worker.once('error', onError);
  });
}

async function build(worker, options = {}) {
  const result = response(worker); worker.send(options); return result;
}

describe('Webpack image and CSS update contracts', function () {
  it('loads the unchanged toolbar image URL from the production application CSS', async function () {
    await serve(path.join(root, 'node_modules/.cache/_ns_cache/public'), '/bundle', async (page, origin, requests) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
      await assertImage(page, origin, '/bundle');
      assert.ok(requests.includes('/bundle' + imagePath));
      const map = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/.cache/_ns_cache/public/js/bundle.app.js.map'), 'utf8'));
      for (const file of ['drawer.css', 'dropdown.css', 'sgv.css']) {
        const index = map.sources.findIndex(source => source.includes('static/css/' + file));
        assert.ok(index >= 0, 'Missing CSS source map: ' + file);
        assert.equal(map.sourcesContent[index], fs.readFileSync(path.join(root, 'static/css', file), 'utf8'));
      }
    });
  });

  for (const template of ['index', 'adminindex', 'profileindex', 'foodindex', 'reportindex']) {
    it('preserves the static stylesheet cascade for ' + template, async function () {
      const file = path.join(root, 'views', template + '.html');
      const markup = ejs.render(fs.readFileSync(file, 'utf8'), {type: template === 'index' ? 'index' : template.replace(/index$/, ''), title: '', bundle: '/bundle'}, {filename: file});
      await serve(path.join(root, 'node_modules/.cache/_ns_cache/public'), '/bundle', async (page, origin) => {
        await page.goto(origin);
        const sheets = await page.evaluate(markup => {
          const parsed = new DOMParser().parseFromString(markup, 'text/html');
          parsed.querySelectorAll('script, audio, img').forEach(node => node.remove());
          document.body.replaceChildren(...parsed.body.childNodes);
          return [...parsed.head.querySelectorAll('link[as="style"], style')].map(node => node.tagName === 'STYLE'
            ? {text: node.textContent} : {url: node.getAttribute('href')});
        }, markup);
        for (const sheet of sheets) {
          const css = sheet.text === undefined ? fs.readFileSync(path.join(root, 'static', sheet.url.replace(/^\//, '')), 'utf8') : sheet.text;
          // External fonts are outside the finite fixture; preserve every other declaration.
          const externalFonts = [
            "@import url('https://fonts.googleapis.com/css?family=Ubuntu:400,700');",
            '@import url("//fonts.googleapis.com/css?family=Ubuntu:300,400,500,700,300italic,400italic,500italic,700italic");',
            '@import url("//fonts.googleapis.com/css?family=Open+Sans:300italic,400italic,600italic,700italic,300,400,600,700,800");'
          ];
          await page.addStyleTag({content: externalFonts.reduce((text, font) => text.replace(font, ''), css)});
        }
        async function snapshot() {
          return page.evaluate(() => [...document.body.querySelectorAll('[id]')].map(node => {
            const css = getComputedStyle(node);
            const properties = ['display', 'position', 'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'margin', 'padding', 'borderWidth', 'borderColor', 'width', 'height', 'overflow', 'pointerEvents'];
            return [node.id, Object.fromEntries(properties.map(key => [key, css[key]]))];
          }));
        }
        const widths = [390, 1280], before = [];
        for (const width of widths) {
          await page.setViewportSize({width, height: 900});
          before.push(await snapshot());
        }
        await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
        for (const [index, width] of widths.entries()) {
          await page.setViewportSize({width, height: 900});
          assert.deepEqual(await snapshot(), before[index], template + ' at width ' + width);
        }
      });
    });
  }

  it('applies two real CSS hot updates while preserving the development image URL and page state', async function () {
    this.timeout(60000);
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const worker = fork(path.join(__dirname, 'asset-build-worker.js'), [], {env: {...env, NODE_ENV: 'development'}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let errors = '';
    worker.stderr.on('data', chunk => {errors = (errors + chunk).slice(-10000);});
    try {
      assert.equal((await response(worker)).ready, true);
      let previous = await build(worker);
      await serve(previous.output, '/devbundle', async (page, origin, requests) => {
        await page.goto(origin);
        await page.addScriptTag({url: origin + '/devbundle/js/bundle.fixture.js'});
        await assertImage(page, origin, '/devbundle');
        assert.equal(await page.evaluate(() => window.assetBoots), 1);
        assert.equal(await page.locator('style[data-webpack]').count(), 1);
        await page.evaluate(() => {window.pageState = 'retained';});
        for (const [color, expected] of [['#123456', 'rgb(18, 52, 86)'], ['#654321', 'rgb(101, 67, 33)']]) {
          const next = await build(worker, {color});
          assert.notEqual(next.hash, previous.hash);
          assert.ok(next.assets.some(name => name.includes(previous.hash) && name.endsWith('.hot-update.json')));
          const updated = await page.evaluate(() => window.assetHot.check(true));
          assert.ok(updated.length > 0);
          assert.equal(await page.locator('#toolbar').evaluate(node => getComputedStyle(node).backgroundColor), expected);
          await assertImage(page, origin, '/devbundle');
          assert.equal(await page.locator('style[data-webpack]').count(), 1, 'CSS updates must reuse the owned style element');
          assert.deepEqual(await page.evaluate(() => [window.assetBoots, window.pageState, window.assetHot.status()]), [1, 'retained', 'idle']);
          assert.ok(requests.some(url => url.includes(previous.hash) && url.endsWith('.hot-update.json')));
          previous = next;
        }
      });
    } catch (error) {error.message += '\nCompiler stderr: ' + errors; throw error;}
    finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, 'exit');
        const timer = setTimeout(() => worker.kill('SIGKILL'), 5000);
        try {
          if (worker.connected) worker.send({close: true});
          else worker.kill('SIGTERM');
          const [code, signal] = await exited;
          assert.equal(signal, null, 'Asset compiler needed forced shutdown');
          assert.equal(code, 0, 'Asset compiler shutdown failed');
        } finally {clearTimeout(timer);}
      }
    }
  });
});
