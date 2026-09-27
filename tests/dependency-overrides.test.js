'use strict';

const assert = require('assert');
const { createRequire } = require('module');
const semver = require('semver');

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
