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

function canonicalResolver (options = {}) {
  return createResolver({
    mode: 'canonical-internal',
    internalNames: [
      { host: 'internal-one.example.net', tenant: 'internal_42' },
      { host: 'internal-other.example.net', tenant: 'internal_99' }
    ],
    aliases: [
      { host: 'public-one.example.org', tenant: 'internal_42' },
      { host: 'public-two.example.org', tenant: 'internal_42' },
      { host: 'public-other.example.org', tenant: 'internal_99' }
    ],
    trustedProxy: req => req.socket.trusted === true,
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
    assert.equal(resolver({ mode: 'direct-alias' }).resolve(request('random-one.example.org')), 'internal_42');
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

  it('validates canonical mode and copies unique, unambiguous canonical maps', function () {
    const internalNames = [{ host: 'internal-one.example.net', tenant: 'internal_42' }];
    const resolve = canonicalResolver({ internalNames, aliases: [] });
    internalNames[0].tenant = 'internal_99';
    assert.equal(resolve.resolve(Object.assign(request('internal-one.example.net'), {
      socket: { trusted: true }
    })), 'internal_42');

    assert.throws(() => createResolver({ mode: 'unknown', aliases: [] }), TypeError);
    assert.throws(() => createResolver({ mode: 'canonical-internal', internalNames: [
      { host: 'one.example.net', tenant: 'internal_42' }
    ] }), TypeError);
    assert.throws(() => createResolver({ mode: 'canonical-internal', trustedProxy: () => true }), TypeError);
    assert.throws(() => resolver({ internalNames: [] }), TypeError);
    assert.throws(() => canonicalResolver({ internalNames: [
      { host: 'internal-one.example.net', tenant: 'internal_42' },
      { host: 'INTERNAL-one.example.net', tenant: 'internal_99' }
    ] }), { code: 'TENANT_INTERNAL_NAME_DUPLICATE' });
    assert.throws(() => canonicalResolver({ internalNames: [
      { host: 'internal-one.example.net', tenant: 'internal_42' },
      { host: 'internal-two.example.net', tenant: 'internal_42' }
    ] }), { code: 'TENANT_CANONICAL_NAME_DUPLICATE' });
    assert.throws(() => canonicalResolver({ aliases: [
      { host: 'INTERNAL-one.example.net', tenant: 'internal_42' }
    ] }), { code: 'TENANT_HOST_AMBIGUOUS' });
    assert.throws(() => canonicalResolver({ internalNames: [
      { host: 'internal-one.example.net:443', tenant: 'internal_42' }
    ] }), { code: 'TENANT_HOST_INVALID' });
    assert.throws(() => canonicalResolver({ aliases: [
      { host: 'orphan.example.org', tenant: 'internal_77' }
    ] }), { code: 'TENANT_CANONICAL_NAME_MISSING' });
  });

  it('selects only the trusted canonical Host while public names rotate as metadata', function () {
    const resolve = canonicalResolver();
    const knownAlias = request('INTERNAL-ONE.EXAMPLE.NET:443', [
      'X-Forwarded-Host', 'public-two.example.org'
    ]);
    knownAlias.socket.trusted = true;
    assert.equal(resolve.resolve(knownAlias), 'internal_42');

    const rotatedAlias = request('internal-one.example.net', [
      'X-Forwarded-Host', 'new-public-name.example.org'
    ]);
    rotatedAlias.socket.trusted = true;
    assert.equal(resolve.resolve(rotatedAlias), 'internal_42');

    const conflict = request('internal-one.example.net', [
      'X-Forwarded-Host', 'public-other.example.org'
    ]);
    conflict.socket.trusted = true;
    refuses(resolve, conflict, 'TENANT_SELECTOR_CONFLICT');
  });

  it('does not rescue an unknown canonical Host with a public alias or ID assertion', function () {
    const resolve = canonicalResolver();
    for (const extra of [
      ['X-Forwarded-Host', 'public-one.example.org'],
      ['X-Resolved-Tenant', 'internal_42'],
      ['X-Forwarded-Host', 'public-one.example.org', 'X-Resolved-Tenant', 'internal_42']
    ]) {
      const req = request('unknown-internal.example.net', extra);
      req.socket.trusted = true;
      refuses(resolve, req, 'TENANT_HOST_UNKNOWN');
    }
  });

  it('requires fresh exact synchronous transport trust even for Host-only requests', function () {
    const resolve = canonicalResolver();
    const req = request('internal-one.example.net');
    refuses(resolve, req, 'TENANT_PROXY_UNTRUSTED');
    req.socket.trusted = true;
    assert.equal(resolve.resolve(req), 'internal_42');
    req.socket.trusted = false;
    refuses(resolve, req, 'TENANT_PROXY_UNTRUSTED');

    for (const trustedProxy of [() => 'true', async () => true]) {
      const untrusted = canonicalResolver({ trustedProxy });
      refuses(untrusted, request('internal-one.example.net'), 'TENANT_PROXY_UNTRUSTED');
    }
    assert.throws(() => canonicalResolver({ trustedProxy: () => { throw new Error('private detail'); } })
      .resolve(Object.assign(request('internal-one.example.net'), { socket: { trusted: true } })),
    error => !/^TENANT_/.test(error.code || '') && !error.message.includes('private detail'));
  });

  it('retains strict wire selector parsing in canonical mode', function () {
    const resolve = canonicalResolver();
    const malformedCases = [
      [request('internal-one.example.net', ['X-Forwarded-Host', 'public-one.example.org',
        'x-forwarded-host', 'other.example.org']), 'TENANT_SELECTOR_DUPLICATE'],
      [request('internal-one.example.net', ['X-Forwarded-Host', 'public-one.example.org,other.example.org']),
        'TENANT_SELECTOR_INVALID'],
      [request('internal-one.example.net', ['X-Forwarded-Host', 'bad_name.example.org']),
        'TENANT_HOST_INVALID'],
      [request('internal-one.example.net', ['X-Resolved-Tenant', 'internal_42,internal_42']),
        'TENANT_SELECTOR_INVALID'],
      [request('internal-one.example.net', ['X-Resolved-Tenant', 'bad/id']), 'TENANT_ID_INVALID'],
      [request('internal-one.example.net', ['Host', 'internal-one.example.net']), 'TENANT_SELECTOR_DUPLICATE']
    ];
    for (const [req, code] of malformedCases) {
      req.socket.trusted = true;
      refuses(resolve, req, code);
    }
  });
});
