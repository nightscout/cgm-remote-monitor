'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const semver = require('semver');
const lock = require('../package-lock.json');
const root = path.resolve(__dirname, '..');

// package.json `overrides` win over every declared range, so an override
// value inside an advisory range is invisible to `npm audit fix` (BF-147).
// These pin the resolved copies, not the override text, so a lockfile that
// drifts back below the fix fails here.
function resolvedFrom (parent, name) {
  const parentRequire = createRequire(require.resolve(parent + '/package.json'));
  return parentRequire(name + '/package.json').version;
}

describe('overridden dependency versions', function () {
  const ajvConsumers = ['har-validator', 'style-loader/node_modules/schema-utils', 'eslint'];

  ajvConsumers.forEach(function (parent) {
    it('resolves ajv 6 at or above 6.14.0 for ' + parent, function () {
      let version;
      try {
        version = resolvedFrom(parent, 'ajv');
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') this.skip();
        throw err;
      }
      if (semver.major(version) !== 6) this.skip();
      assert.ok(semver.gte(version, '6.14.0'), parent + ' resolves ajv ' + version);
    });
  });

  it('resolves request\'s form-data at or above 2.5.6', function () {
    const version = resolvedFrom('request', 'form-data');
    assert.ok(semver.gte(version, '2.5.6'), 'request resolves form-data ' + version);
  });

  it('escapes line breaks in multipart field names and filenames built through request', function () {
    const FormData = createRequire(require.resolve('request/package.json'))('form-data');
    const form = new FormData();
    form.append('name\r\nX-Extra: 1', 'value', { filename: 'file\r\n.txt' });
    const head = form.getBuffer().toString().split('\r\n')[1];
    assert.strictEqual(head, 'Content-Disposition: form-data; name="name%0D%0AX-Extra: 1"; filename="file%0D%0A.txt"');
  });
});

// Floors for the advisories published after 2026-09-27 (BF-153). Each locked
// copy is read from the installed tree; a major with no floor is a separate
// line (nightscout-connect's axios 1.x) and is not checked here.
describe('advisory floors in the installed tree', function () {
  const floors = {
    'ip-address': { 10: '10.7.1' },
    'fast-uri': { 3: '3.1.8' },
    'axios': { 0: '0.34.0' },
    'dompurify': { 3: '3.4.16' },
    'webpack-dev-middleware': { 8: '8.3.0' }
  };

  Object.keys(floors).forEach(function (name) {
    const copies = Object.entries(lock.packages)
      .filter(([packagePath]) => packagePath === 'node_modules/' + name || packagePath.endsWith('/node_modules/' + name));

    it('finds a locked ' + name + ' copy on every floored major', function () {
      const majors = copies.map(([, entry]) => String(semver.major(entry.version)));
      Object.keys(floors[name]).forEach(major => assert.ok(majors.includes(major), name + ' ' + major + '.x not locked'));
    });

    copies.forEach(function ([packagePath, entry]) {
      it('installs ' + packagePath + ' at or above its floor', function () {
        // Read the file directly: some of these packages do not export package.json.
        // The path comes only from the committed lockfile.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const installed = JSON.parse(fs.readFileSync(path.join(root, packagePath, 'package.json'), 'utf8'));
        assert.strictEqual(installed.version, entry.version, packagePath + ' does not match the lockfile');
        const floor = floors[name][semver.major(installed.version)];
        if (!floor) this.skip();
        assert.ok(semver.gte(installed.version, floor), packagePath + ' installs ' + installed.version + ', below ' + floor);
      });
    });
  });

  describe('ip-address as loaded by the MongoDB driver\'s SOCKS client', function () {
    const socksRequire = createRequire(createRequire(require.resolve('mongodb')).resolve('socks'));
    const { Address4, Address6 } = socksRequire('ip-address');

    it('does not place an address inside a subnet of the other family', function () {
      assert.strictEqual(new Address6('::1').isInSubnet(new Address4('0.0.0.0/0')), false);
      assert.strictEqual(new Address4('192.0.2.1').isInSubnet(new Address6('::/0')), false);
      assert.strictEqual(new Address4('192.0.2.1').isInSubnet(new Address4('192.0.2.0/24')), true);
    });

    it('bounds the parse diagnostic for a long invalid IPv6 string', function () {
      let error;
      try {
        new Address6('1:'.repeat(20000) + 'x');
      } catch (err) {
        error = err;
      }
      assert.ok(error, 'long invalid input was accepted');
      assert.ok(String(error.parseMessage || error.message).length < 1000,
        'diagnostic is ' + String(error.parseMessage || error.message).length + ' characters');
    });
  });

  // IMPORT_CONFIG (lib/server/bootevent.js) and the MiniMed bridge both load axios 0.x.
  [['the server', require.resolve('../lib/server/bootevent')], ['minimed-connect-to-nightscout', require.resolve('minimed-connect-to-nightscout/package.json')]]
    .forEach(function ([label, from]) {
      it('keeps the request method when Object.prototype.method is set, for axios loaded by ' + label, async function () {
        const axios = createRequire(from)('axios');
        const adapter = config => Promise.resolve({ data: null, status: 200, statusText: 'OK', headers: {}, config, request: {} });
        Object.prototype.method = 'delete'; // eslint-disable-line no-extend-native
        try {
          const response = await axios({ url: 'http://127.0.0.1:9/settings', adapter });
          assert.strictEqual(response.config.method, 'get');
        } finally {
          delete Object.prototype.method;
        }
      });
    });
});
