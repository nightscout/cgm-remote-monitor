'use strict';

const assert = require('node:assert/strict');
const createResolver = require('../lib/tenant-resolution');

function request (host, extra = []) {
  return { rawHeaders: ['Host', host, ...extra], socket: { trusted: false } };
}

function resolver (options = {}) {
  return createResolver({
    aliases: [
      { host: 'random-one.example.org', tenant: 'internal_42' },
      { host: 'random-two.example.org', tenant: 'internal_42' },
      { host: 'other.example.org', tenant: 'internal_99' }
    ],
    ...options
  });
}

function refuses (resolve, req, code) {
  assert.throws(() => resolve.resolve(req), { code });
}

describe('tenant resolution boundary', function () {
  it('maps rotated aliases to a stable identity, independent of host case and port', function () {
    const resolve = resolver();
    assert.equal(resolve.resolve(request('RANDOM-ONE.EXAMPLE.ORG:443')), 'internal_42');
    assert.equal(resolve.resolve(request('random-two.example.org')), 'internal_42');
    assert.equal(resolve.resolve(request('other.example.org')), 'internal_99');
  });

  it('copies configuration and rejects duplicate canonical aliases', function () {
    const aliases = [{ host: 'one.example.org', tenant: 'internal_42' }];
    const resolve = createResolver({ aliases });
    aliases[0].tenant = 'internal_99';
    aliases.push({ host: 'new.example.org', tenant: 'internal_99' });
    assert.equal(resolve.resolve(request('one.example.org')), 'internal_42');
    refuses(resolve, request('new.example.org'), 'TENANT_HOST_UNKNOWN');
    assert.throws(() => createResolver({ aliases: [
      { host: 'one.example.org', tenant: 'internal_42' },
      { host: 'ONE.example.org:443', tenant: 'internal_99' }
    ] }), { code: 'TENANT_ALIAS_DUPLICATE' });
  });

  it('refuses missing, unknown, and malformed hosts without a default', function () {
    const resolve = resolver();
    refuses(resolve, request('unknown.example.org'), 'TENANT_HOST_UNKNOWN');
    for (const host of ['', 'https://random-one.example.org', 'random-one.example.org/path',
      'random-one.example.org.', ' random-one.example.org', 'random-one.example.org ',
      'one..example.org', '-one.example.org', 'one-.example.org', 'one_example.org',
      'one.example.org@other.example.org', 'one.example.org\r\nHost: other.example.org',
      '127.0.0.1', '[::1]', 'one.example.org:0', 'one.example.org:65536',
      'one.example.org:abc', 'one.example.org:', 'a'.repeat(64) + '.example.org',
      'a'.repeat(260), 'é.example.org', 'K.example.org', 'random-one.example.org\n', undefined, 42]) {
      assert.throws(() => resolve.resolve(request(host)), err => /^TENANT_/.test(err.code));
    }
    refuses(resolve, { rawHeaders: [] }, 'TENANT_HOST_INVALID');
    refuses(resolve, { headers: { host: 'random-one.example.org' } }, 'TENANT_HEADERS_INVALID');
    refuses(resolve, { rawHeaders: ['Host'] }, 'TENANT_HEADERS_INVALID');
  });

  it('refuses duplicate and list selectors, including duplicates hidden by Node headers', function () {
    const resolve = resolver({ trustedProxy: () => true });
    for (const [name, value] of [
      ['Host', 'random-one.example.org'],
      ['X-Forwarded-Host', 'random-one.example.org'],
      ['X-Resolved-Tenant', 'internal_42']
    ]) {
      const req = name === 'Host' ? request(value, ['hOsT', value]) :
        request('random-one.example.org', [name, value, name.toLowerCase(), value]);
      req.headers = { host: 'random-one.example.org' };
      refuses(resolve, req, 'TENANT_SELECTOR_DUPLICATE');
      refuses(resolve, request('random-one.example.org', [name, value + ',' + value]),
        name === 'Host' ? 'TENANT_SELECTOR_DUPLICATE' : 'TENANT_SELECTOR_INVALID');
    }
    refuses(resolve, request('random-one.example.org,other.example.org'), 'TENANT_SELECTOR_INVALID');
  });

  it('rejects external proxy selectors even when they name a known tenant', function () {
    for (const options of [{}, { trustedProxy: () => false }, { trustedProxy: () => 'true' },
      { trustedProxy: async () => true }]) {
      const resolve = resolver(options);
      refuses(resolve, request('random-one.example.org', ['X-Resolved-Tenant', 'internal_99']),
        'TENANT_PROXY_UNTRUSTED');
      refuses(resolve, request('random-one.example.org', ['X-Resolved-Tenant', 'internal_42']),
        'TENANT_PROXY_UNTRUSTED');
      refuses(resolve, request('random-one.example.org', ['X-Forwarded-Host', 'other.example.org']),
        'TENANT_PROXY_UNTRUSTED');
    }
  });

  it('uses a trusted public alias independently of the backend and checks the internal handoff', function () {
    const resolve = resolver({ trustedProxy: req => req.socket.trusted === true });
    const req = request('backend.example.net:3000', [
      'X-Forwarded-Host', 'random-two.example.org', 'X-Resolved-Tenant', 'internal_42'
    ]);
    refuses(resolve, req, 'TENANT_PROXY_UNTRUSTED');
    req.socket.trusted = true;
    assert.equal(resolve.resolve(req), 'internal_42');
    const direct = request('random-one.example.org', ['X-Resolved-Tenant', 'internal_42']);
    direct.socket.trusted = true;
    assert.equal(resolve.resolve(direct), 'internal_42');
    direct.rawHeaders[3] = 'internal_99';
    refuses(resolve, direct, 'TENANT_SELECTOR_CONFLICT');
    direct.rawHeaders[3] = '../invalid';
    refuses(resolve, direct, 'TENANT_ID_INVALID');
    direct.rawHeaders[3] = 'internal_42\n';
    refuses(resolve, direct, 'TENANT_ID_INVALID');
    req.rawHeaders[3] = 'unknown.example.org';
    refuses(resolve, req, 'TENANT_HOST_UNKNOWN');
    req.rawHeaders[3] = 'https://random-one.example.org';
    refuses(resolve, req, 'TENANT_HOST_INVALID');
    req.rawHeaders[1] = 'bad host';
    refuses(resolve, req, 'TENANT_HOST_INVALID');
  });

  it('requires valid operator configuration', function () {
    assert.throws(() => createResolver(), TypeError);
    assert.throws(() => resolver({ aliases: [] }), TypeError);
    assert.throws(() => resolver({ trustedProxy: true }), TypeError);
    assert.throws(() => resolver({ aliases: [{ host: '*.example.org', tenant: 'internal_42' }] }),
      { code: 'TENANT_HOST_INVALID' });
    assert.throws(() => resolver({ aliases: [{ host: 'one.example.org', tenant: 'db://backend' }] }),
      { code: 'TENANT_ID_INVALID' });
  });
});
