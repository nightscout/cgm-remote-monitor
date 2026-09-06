'use strict';

const should = require('should');
const deepMerge = require('../lib/utils/deepMerge');

describe('deepMerge', function () {
  afterEach(function () {
    delete Object.prototype.polluted;
  });

  it('merges nested objects and replaces arrays', function () {
    const replacement = [{ name: 'iob' }];
    const target = {
      settings: {
        enabled: false,
        nested: { preserved: true }
      },
      plugins: ['bgnow']
    };

    const result = deepMerge(target, {
      settings: {
        enabled: true,
        nested: { added: true }
      },
      plugins: replacement
    });

    result.should.equal(target);
    result.should.deepEqual({
      settings: {
        enabled: true,
        nested: { preserved: true, added: true }
      },
      plugins: replacement
    });
    result.plugins.should.equal(replacement);
  });

  it('rejects prototype-polluting keys at every depth', function () {
    const payload = JSON.parse([
      '{',
      '"__proto__":{"polluted":"root"},',
      '"settings":{',
      '"enabled":true,',
      '"__proto__":{"polluted":"nested"},',
      '"constructor":{"prototype":{"polluted":"constructor"}},',
      '"prototype":{"polluted":"prototype"}',
      '}',
      '}'
    ].join(''));

    const result = deepMerge({}, payload);

    should(Object.prototype.polluted).be.undefined();
    result.should.deepEqual({ settings: { enabled: true } });
    Object.prototype.hasOwnProperty.call(result, '__proto__').should.be.false();
    Object.prototype.hasOwnProperty.call(result.settings, '__proto__').should.be.false();
    Object.prototype.hasOwnProperty.call(result.settings, 'constructor').should.be.false();
    Object.prototype.hasOwnProperty.call(result.settings, 'prototype').should.be.false();
  });

  it('ignores inherited source properties', function () {
    const inherited = {
      ignored: true,
      nested: { ignored: true }
    };
    const source = Object.create(inherited);
    source.own = { included: true };

    const result = deepMerge({}, source);

    result.should.deepEqual({ own: { included: true } });
    Object.prototype.hasOwnProperty.call(result, 'ignored').should.be.false();
    Object.prototype.hasOwnProperty.call(result, 'nested').should.be.false();
  });

  it('does not merge into inherited target properties', function () {
    const inheritedSettings = { preserved: true };
    const target = Object.create({ settings: inheritedSettings });

    deepMerge(target, { settings: { enabled: true } });

    Object.prototype.hasOwnProperty.call(target, 'settings').should.be.true();
    target.settings.should.deepEqual({ enabled: true });
    target.settings.should.not.equal(inheritedSettings);
    inheritedSettings.should.deepEqual({ preserved: true });
  });
});
