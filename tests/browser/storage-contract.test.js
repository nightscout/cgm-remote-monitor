'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {once} = require('node:events');
const {getBrowser} = require('./hooks');

// Capture the persisted-data contract before changing the implementation.
const source = fs.readFileSync(process.env.NIGHTSCOUT_STORAGE_ORACLE || require.resolve('../../lib/client/storage'), 'utf8');
const script = '(function () { const module = {exports: {}}; const exports = module.exports; ' + source + '; window.storageContract = module.exports; })();';

describe('Browser storage persisted-data contract', function () {
  let server, origin;
  before(async function () {
    server = http.createServer((request, response) => response.end('<!doctype html><title>Owned storage fixture</title>'));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () { if (server) await new Promise(resolve => server.close(resolve)); });

  async function check(run, blocked = false) {
    const context = await getBrowser().newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      if (blocked === 'quota') await page.evaluate(() => {
        Storage.prototype.setItem = () => {throw new DOMException('Fixture full', 'QuotaExceededError');};
      });
      if (blocked === true) await page.evaluate(() => Object.defineProperty(window, 'localStorage', {
        get() {throw new DOMException('Fixture denied storage', 'SecurityError');}
      }));
      await page.addScriptTag({content: script});
      return await page.evaluate(run);
    } finally {await context.close();}
  }

  it('keeps authentication tokens readable by the raw clock API across writes', async function () {
    assert.deepEqual(await check(() => {
      const store = window.storageContract.localStorage, values = [];
      for (const token of ['b723e97aa97846eb92d5264f084b2823f57c4aa1', 'subject-fixture-token']) {
        values.push(store.set('apisecrethash', token), localStorage.getItem('apisecrethash'), store.get('apisecrethash'));
      }
      return values;
    }), ['b723e97aa97846eb92d5264f084b2823f57c4aa1', 'b723e97aa97846eb92d5264f084b2823f57c4aa1', 'b723e97aa97846eb92d5264f084b2823f57c4aa1',
      'subject-fixture-token', 'subject-fixture-token', 'subject-fixture-token']);
  });

  it('reads old raw, JSON, missing and malformed values without rewriting them', async function () {
    const result = await check(() => {
      const raw = ['', 'false', 'true', '0', '12.5', 'null', 'undefined', '{bad', '[1,2]', '{"insulin":false}', '"quoted"'];
      const store = window.storageContract.localStorage;
      return {missing: store.get('missing'), rows: raw.map((value, i) => {
        localStorage.setItem('fixture-' + i, value);
        return [store.get('fixture-' + i), localStorage.getItem('fixture-' + i)];
      })};
    });
    assert.deepEqual(result, {missing: null, rows: [['', ''], [false, 'false'], [true, 'true'], [0, '0'], [12.5, '12.5'],
      [null, 'null'], ['undefined', 'undefined'], ['{bad', '{bad'], [[1, 2], '[1,2]'], [{insulin: false}, '{"insulin":false}'], ['quoted', '"quoted"']]});
  });

  it('serializes settings and report objects without retaining caller references', async function () {
    assert.deepEqual(await check(() => {
      const store = window.storageContract.localStorage;
      const settings = {insulin: false, carbs: true};
      store.set('reportProperties', settings); settings.insulin = true;
      const first = store.get('reportProperties'); first.carbs = false;
      store.set('showPlugins', ['iob', 'cob']); store.set('showForecast', false);
      return [store.get('reportProperties'), store.get('showPlugins'), store.get('showForecast')];
    }), [{insulin: false, carbs: true}, ['iob', 'cob'], false]);
  });

  it('removes a key repeatedly without disturbing neighboring settings', async function () {
    assert.deepEqual(await check(() => {
      const store = window.storageContract.localStorage;
      store.set('apisecrethash', 'fixture'); store.set('language', 'en');
      return [store.remove('apisecrethash'), store.remove('apisecrethash'), store.get('apisecrethash'), store.get('language')];
    }), [true, true, null, 'en']);
  });

  it('preserves empty, numeric, unicode and object-prototype key names', async function () {
    assert.deepEqual(await check(() => {
      const store = window.storageContract.localStorage;
      return ['', '0', 'résumé', '__proto__', 'constructor'].map(key => {
        store.set(key, 'fixture'); const value = store.get(key); store.remove(key); return [key, value, store.get(key)];
      });
    }), ['', '0', 'résumé', '__proto__', 'constructor'].map(key => [key, 'fixture', null]));
  });

  it('preserves dotted-key nesting in existing stored objects', async function () {
    assert.deepEqual(await check(() => {
      const store = window.storageContract.localStorage;
      store.set('fixture.option', false);
      const first = store.get('fixture.option');
      store.set('fixture.other', 3); store.remove('fixture.option');
      return [first, store.get('fixture'), localStorage.getItem('fixture.option')];
    }), [false, {other: 3}, null]);
  });

  it('keeps local and session data separate', async function () {
    assert.deepEqual(await check(() => {
      const api = window.storageContract;
      api.localStorage.set('fixture', 'local'); api.sessionStorage.set('fixture', 'session');
      api.localStorage.remove('fixture');
      return [api.localStorage.get('fixture'), api.sessionStorage.get('fixture')];
    }), [null, 'session']);
  });

  it('returns null for unavailable persistence without falling back to cookies', async function () {
    assert.deepEqual(await check(() => {
      const store = window.storageContract.localStorage;
      return [store.get('fixture'), store.set('fixture', 'value'), store.remove('fixture'), document.cookie];
    }, true), [null, null, null, '']);
  });
  it('handles storage that is readable but has no writable quota at startup', async function () {
    assert.deepEqual(await check(() => {
      const store = window.storageContract.localStorage;
      return [store.get('fixture'), store.set('fixture', 'value'), store.remove('fixture')];
    }, 'quota'), [null, null, null]);
  });

  it('retains bulk, nested and selected-key operations on the public export', async function () {
    assert.deepEqual(await check(() => {
      const store = window.storageContract.localStorage;
      store.set({plain: 'hello', list: [1, 2], object: {flag: false}});
      store.set('nested', 'items', 0, 'value', 7);
      const values = [store.get(['plain', 'list']), store.get('nested', 'items', 0, ['value']), store.keys('object')];
      store.remove(['plain', 'list']); store.remove('object', ['flag']);
      return [...values, store.get('object'), store.isSet(['plain', 'object']), store.isEmpty('object')];
    }), [{plain: 'hello', list: '1,2'}, {value: 7}, ['flag'], {}, false, true]);
  });

  it('retains explicit JSON mode and boolean presence/emptiness distinctions', async function () {
    assert.deepEqual(await check(() => {
      const api = window.storageContract, store = api.localStorage;
      api.alwaysUseJsonInStorage(true); store.set('string', 'false'); store.set('boolean', false);
      const first = [localStorage.getItem('string'), store.get('string'), store.isSet('boolean'), store.isEmpty('boolean')];
      api.alwaysUseJsonInStorage(false); store.set('string', 'false');
      return [...first, store.get('string'), store.isEmpty('missing')];
    }), ['"false"', 'false', true, false, false, true]);
  });

  it('retains isolated namespaces, enumeration and clear/reinitialize behavior', async function () {
    assert.deepEqual(await check(() => {
      const api = window.storageContract, group = api.initNamespaceStorage('fixture');
      group.localStorage.set({a: 1, b: false}); group.sessionStorage.set('a', 2);
      const first = [group.localStorage.get(), group.sessionStorage.get('a'), group.localStorage.keys().sort()];
      group.localStorage.removeAll();
      const cleared = group.localStorage.get();
      api.localStorage.set('outside', 'value'); api.removeAllStorages(true);
      const retained = [Object.keys(api.namespaceStorages), api.localStorage.get('fixture'), api.sessionStorage.get('fixture'), api.localStorage.get('outside')];
      api.removeAllStorages();
      return [...first, cleared, ...retained, Object.keys(api.namespaceStorages), localStorage.length, sessionStorage.length];
    }), [{a: 1, b: false}, 2, ['a', 'b'], {}, ['fixture'], {}, {}, null, [], 0, 0]);
  });

});
