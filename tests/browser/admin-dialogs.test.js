'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once, EventEmitter} = require('node:events');
const {withPage} = require('./fixture');

describe('Authorization editor dialogs', function () {
  let server, origin, records, writes, pending, events, readFailure;
  before(async function () {
    const assets = new Map([
      ['/app.js', ['application/javascript', fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'))]],
      ['/admin.js', ['application/javascript', fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.admin.js'))]],
      ['/ui.css', ['text/css', fs.readFileSync(path.resolve(__dirname, '../../static/css/ui-darkness/jquery-ui.min.css'))]]
    ]);
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (assets.has(url.pathname)) {
        const [type, body] = assets.get(url.pathname);
        res.writeHead(200, {'Content-Type': type}).end(body); return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end('<!doctype html><html><head><link rel="stylesheet" href="/ui.css"></head><body><button id="open-editor">Open editor</button></body></html>'); return;
      }
      if (/^\/api\/v2\/authorization\/(roles|subjects)\/?$/.test(url.pathname)) {
        if (req.method === 'GET') {
          if (readFailure) {res.writeHead(500).end(); return;}
          res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(records)); return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const write = {method: req.method, body: new URLSearchParams(body)};
          writes.push(write);
          pending = res;
          events.emit('write', write);
          return;
        }
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  beforeEach(function () {records = []; writes = []; pending = null; events = new EventEmitter(); readFailure = false;});
  afterEach(function () {if (pending && !pending.writableEnded) pending.end();});
  after(async function () {if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}});

  async function setup(page, name) {
    await page.goto(origin);
    await page.addScriptTag({url: origin + '/app.js'});
    await page.addScriptTag({url: origin + '/admin.js'});
    await page.evaluate(name => new Promise(resolve => {
      const plugin = window.Nightscout.admin_plugins(name);
      const translations = {Save: 'Enregistrer', Cancel: 'Annuler'};
      const client = {headers: () => ({}), translate: text => translations[text] || text};
      for (const suffix of ['html', 'status']) {
        const node = document.createElement('div'); node.id = 'admin_' + name + '_0_' + suffix; document.body.append(node);
      }
      document.querySelector('#open-editor').addEventListener('click', () => plugin.actions[0].code(client));
      plugin.actions[0].init(client, resolve);
    }), name);
  }

  for (const [name, prefix, field, dialogId] of [
    ['roles', 'edrole', 'permissions', 'editroledialog'],
    ['subjects', 'edsub', 'roles', 'editsubjectdialog']
  ]) {
    it(name + ': cancel/Escape restore focus; repeated saves preserve exact normalized payloads', async function () {
      await withPage(origin, async ({page}) => {
        await setup(page, name);
        const dialog = page.getByRole('dialog');
        for (let cycle = 0; cycle < 2; cycle++) {
          for (const dismiss of ['cancel', 'escape']) {
            await page.locator('#open-editor').focus();
            await page.locator('#open-editor').press('Enter');
            await page.locator('#' + dialogId).waitFor({state: 'visible'});
            assert.equal(await page.evaluate(() => document.activeElement.id), prefix + '_name');
            await page.locator('#' + prefix + '_name').fill('Discard this draft');
            if (dismiss === 'cancel') await dialog.getByRole('button', {name: 'Annuler', exact: true}).click();
            else await page.keyboard.press('Escape');
            await dialog.waitFor({state: 'hidden'});
            assert.equal(await page.evaluate(() => document.activeElement.id), 'open-editor');
            assert.equal(writes.length, cycle * 2);
          }
          await page.locator('#open-editor').click();
          await page.locator('#' + prefix + '_name').fill('Owned ' + cycle);
          await page.locator('#' + prefix + '_' + field).fill(' READ ; write,  ADMIN ');
          await page.locator('#' + prefix + '_notes').fill('Notes ' + cycle);
          const sent = once(events, 'write', {signal: AbortSignal.timeout(5000)});
          await dialog.getByRole('button', {name: 'Enregistrer', exact: true}).click();
          const [write] = await sent;
          assert.equal(write.method, 'POST');
          assert.equal(write.body.get('name'), 'Owned ' + cycle);
          assert.deepEqual(write.body.getAll(field + '[]'), ['admin', 'read', 'write']);
          assert.equal(write.body.get('notes'), 'Notes ' + cycle);
          assert.equal(await dialog.isVisible(), true, 'Do not close before the save response');
          records = [{_id: 'owned-' + cycle, name: 'Owned ' + cycle, [field]: ['admin', 'read', 'write'], notes: 'Notes ' + cycle}];
          pending.writeHead(200, {'Content-Type': 'application/json'}).end('{}');
          await dialog.waitFor({state: 'hidden'});
          await page.waitForFunction(() => window.$.active === 0);
          assert.equal(writes.length, cycle * 2 + 1, 'One save per activation after reopening');
          assert.match(await page.locator('#admin_' + name + '_table').textContent(), new RegExp('Owned ' + cycle));
          assert.equal(await page.locator('.ui-dialog').count(), 1, 'Reuse one dialog wrapper');
          await page.locator('#admin_' + name + '_table img').first().click();
          assert.equal(await page.locator('#' + prefix + '_name').inputValue(), 'Owned ' + cycle);
          await page.locator('#' + prefix + '_notes').fill('Edited ' + cycle);
          const edited = once(events, 'write', {signal: AbortSignal.timeout(5000)});
          await dialog.getByRole('button', {name: 'Enregistrer', exact: true}).click();
          const [update] = await edited;
          assert.equal(update.method, 'PUT');
          assert.equal(update.body.get('_id'), 'owned-' + cycle);
          assert.equal(update.body.get('notes'), 'Edited ' + cycle);
          assert.deepEqual(update.body.getAll(field + '[]'), ['admin', 'read', 'write']);
          records[0].notes = 'Edited ' + cycle;
          pending.writeHead(200, {'Content-Type': 'application/json'}).end('{}');
          await dialog.waitFor({state: 'hidden'});
          await page.waitForFunction(() => window.$.active === 0);
          assert.equal(writes.length, (cycle + 1) * 2, 'One PUT per edited record');
          assert.match(await page.locator('#admin_' + name + '_table').textContent(), new RegExp('Edited ' + cycle));

        }
      });
    });

    it(name + ': a successful write closes even if the following list refresh fails', async function () {
      await withPage(origin, async ({page}) => {
        await setup(page, name);
        const dialog = page.getByRole('dialog');
        for (let cycle = 0; cycle < 2; cycle++) {
          await page.locator('#open-editor').click();
          await page.locator('#' + prefix + '_name').fill('Committed ' + cycle);
          const sent = once(events, 'write', {signal: AbortSignal.timeout(5000)});
          await dialog.getByRole('button', {name: 'Enregistrer', exact: true}).click();
          await sent;
          readFailure = true;
          pending.writeHead(200, {'Content-Type': 'application/json'}).end('{}');
          await dialog.waitFor({state: 'hidden'});
          await page.waitForFunction(() => window.$.active === 0);
          assert.equal(await page.locator('#admin_' + name + '_0_status').textContent(), 'Error loading database');
          assert.equal(writes.length, cycle + 1, 'Do not resend a committed write');
        }
      });
    });

    for (const existing of [false, true]) {
    it(name + ': failed ' + (existing ? 'PUT' : 'POST') + ' saves retain the visible draft and allow retry twice', async function () {
      await withPage(origin, async ({page}) => {
        if (existing) records = [{_id: 'owned-edit', name: 'Original', [field]: ['read'], notes: 'Original notes'}];
        await setup(page, name);
        const dialog = page.getByRole('dialog');
        for (let cycle = 0; cycle < 2; cycle++) {
          if (existing) await page.locator('#admin_' + name + '_table img').first().click();
          else await page.locator('#open-editor').click();
          await page.locator('#' + prefix + '_name').fill('Retry ' + cycle);
          await page.locator('#' + prefix + '_' + field).fill('read');
          await page.locator('#' + prefix + '_notes').fill('Keep this draft');
          let sent = once(events, 'write', {signal: AbortSignal.timeout(5000)});
          await dialog.getByRole('button', {name: 'Enregistrer', exact: true}).click();
          const [failedWrite] = await sent;
          assert.equal(failedWrite.method, existing ? 'PUT' : 'POST');
          if (existing) assert.equal(failedWrite.body.get('_id'), 'owned-edit');
          const alerted = page.waitForEvent('dialog').then(async alert => {assert.match(alert.message(), /Unable to save/); await alert.accept();});
          pending.writeHead(500, {'Content-Type': 'application/json'}).end('{"error":"owned failure"}');
          await alerted;
          await page.waitForFunction(() => window.$.active === 0);
          assert.equal(await dialog.isVisible(), true, 'Failed save must not dismiss the draft');
          assert.equal(await page.locator('#' + prefix + '_name').inputValue(), 'Retry ' + cycle);
          assert.equal(await page.locator('#' + prefix + '_notes').inputValue(), 'Keep this draft');
          sent = once(events, 'write', {signal: AbortSignal.timeout(5000)});
          await dialog.getByRole('button', {name: 'Enregistrer', exact: true}).click();
          const [retriedWrite] = await sent;
          assert.equal(retriedWrite.body.toString(), failedWrite.body.toString());
          pending.writeHead(200, {'Content-Type': 'application/json'}).end('{}');
          await dialog.waitFor({state: 'hidden'});
          await page.waitForFunction(() => window.$.active === 0);
          assert.equal(writes.length, (cycle + 1) * 2);
        }
      });
    });
    }
  }
});
