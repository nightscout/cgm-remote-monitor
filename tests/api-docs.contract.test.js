'use strict';

// The two OpenAPI documents (lib/server/swagger.yaml for API v1,
// lib/api3/swagger.yaml for API v3) against the routes the server mounts.
//
// The server is booted with every feature that adds routes enabled, and its
// express route table is read (tests/lib/route-table.js). Every route under
// /api must be described by one of the documents or listed in ALLOWED below
// with the reason, and every documented operation must be mounted. The JSON
// twin of each document must be what scripts/swagger-json.js renders from the
// YAML, and every $ref must resolve.

require('should');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const language = require('../lib/language')();
const {capture, routes} = require('./lib/route-table');
const swaggerJson = require('../scripts/swagger-json');

const ROOT = path.resolve(__dirname, '..');
const V1 = path.join(ROOT, 'lib/server/swagger.yaml');
const V3 = path.join(ROOT, 'lib/api3/swagger.yaml');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Mounted routes under /api that neither document describes, on purpose.
// Each entry is 'METHOD path' in the form routeKey() produces. An entry that
// is no longer mounted fails the test, so this list cannot go stale.
const ALLOWED = {
  // Mounted only when NODE_ENV is development or test, or CI is set
  // (lib/api3/index.js); not part of the API a deployed server offers.
  'GET /api/v3/test': 'development and test only',

  // API v2 serves all of API v1 under /api/v2 (lib/api2/index.js); those
  // routes are matched by v2MirrorOfV1() below. The routes API v2 adds are
  // not described by either document yet. They are a separate surface - the
  // authorization admin plane, remote commands, the data endpoints the web
  // client reads - and are listed one by one so that a new v2 route also
  // fails this test until it is documented or added here.
  'GET /api/v2/authorization/debug/check/{}': 'API v2, not yet documented',
  'GET /api/v2/authorization/permissions': 'API v2, not yet documented',
  'GET /api/v2/authorization/permissions/trie': 'API v2, not yet documented',
  'GET /api/v2/authorization/request/{}': 'API v2, not yet documented',
  'GET /api/v2/authorization/roles': 'API v2, not yet documented',
  'POST /api/v2/authorization/roles': 'API v2, not yet documented',
  'PUT /api/v2/authorization/roles': 'API v2, not yet documented',
  'DELETE /api/v2/authorization/roles/{}': 'API v2, not yet documented',
  'GET /api/v2/authorization/subjects': 'API v2, not yet documented',
  'POST /api/v2/authorization/subjects': 'API v2, not yet documented',
  'PUT /api/v2/authorization/subjects': 'API v2, not yet documented',
  'DELETE /api/v2/authorization/subjects/{}': 'API v2, not yet documented',
  'GET /api/v2/ddata/at{/{}}': 'API v2, not yet documented',
  'POST /api/v2/notifications/loop': 'API v2, not yet documented',
  'GET /api/v2/properties/{*path}': 'API v2, not yet documented',
  'GET /api/v2/summary': 'API v2, not yet documented'
};

// Path templates are compared without parameter names, without a trailing
// slash, and with express 5 optional groups such as `{/:regex}` expanded, so
// '/times{/{prefix}}{/{regex}}' is mounted as '/times', '/times/{}' and
// '/times/{}/{}'.
function normalize (p) {
  const out = p.replace(/\{(\w+)\}/g, '{}');
  return out.length > 1 ? out.replace(/\/$/, '') : out;
}

function variants (p) {
  const group = /\{(\/[^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/;
  const match = group.exec(p);
  if (!match) return [normalize(p)];
  const before = p.slice(0, match.index);
  const after = p.slice(match.index + match[0].length);
  // Optional groups nest only to the right: leaving one out leaves out the rest.
  return [normalize(before)].concat(variants(before + match[1] + after));
}

// 'GET /api/v3/entries/{}': method and path, parameter names left out.
function routeKey (r) {
  return r.method.toUpperCase() + ' ' + r.path.replace(/\{(\w+)\}/g, '{}');
}

function documented (file) {
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const base = doc.servers[0].url;
  const ops = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    const server = item.servers ? item.servers[0].url : base;
    // API v3 documents its generic operations once, under /{collection}.
    let paths = [p];
    if (p.startsWith('/{collection}')) {
      paths = doc.components.schemas.paramCollection.enum.map(c => p.replace('{collection}', c));
    }
    for (const method of METHODS.filter(m => item[m])) {
      for (const one of paths) {
        ops.push({method, path: normalize(server + one), source: path.relative(ROOT, file) + ' ' + method.toUpperCase() + ' ' + p});
      }
    }
  }
  return {doc, ops};
}

function unresolvedRefs (doc) {
  const missing = [];
  (function walk (node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') {
      const target = node.$ref.replace(/^#\//, '').split('/')
        .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((at, key) => (at && Object.prototype.hasOwnProperty.call(at, key) ? at[key] : undefined), doc);
      if (target === undefined) missing.push(node.$ref);
    }
    Object.values(node).forEach(walk);
  })(doc);
  return missing;
}

describe('API documents match the mounted routes', function () {
  this.timeout(30000);
  const self = this;

  before(function (done) {
    const saved = {ENABLE: process.env.ENABLE, API_SECRET: process.env.API_SECRET};
    process.env.API_SECRET = 'this is my long pass phrase';
    process.env.ENABLE = 'careportal boluscalc food api alexa googlehome pushover loop openaps cors';
    const env = require('../lib/server/env')();
    env.insecureUseHttp = true;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      const app = capture(() => require('../lib/server/app')(env, ctx));
      self.mounted = routes(app).filter(r => r.path.startsWith('/api/'));
      done();
    });
  });

  it('reads a route table that includes both APIs', function () {
    // Guards the checks below against an empty or partial table.
    const keys = self.mounted.map(routeKey);
    keys.should.containEql('GET /api/v1/entries');
    keys.should.containEql('POST /api/v1/treatments/');
    keys.should.containEql('GET /api/v3/entries/{}');
    keys.should.containEql('POST /api/v1/alexa');
  });

  it('documents every mounted /api route, or allows it by name', function () {
    const docOps = new Set(documented(V1).ops.concat(documented(V3).ops).map(o => o.method + ' ' + o.path));
    const v1Mounted = new Set(self.mounted.filter(r => r.path.startsWith('/api/v1/'))
      .flatMap(r => variants(r.path).map(v => r.method + ' ' + v)));
    const v2MirrorOfV1 = r => r.path.startsWith('/api/v2/')
      && variants(r.path).some(v => v1Mounted.has(r.method + ' ' + v.replace('/api/v2/', '/api/v1/')));

    const undocumented = self.mounted.filter(r => !ALLOWED[routeKey(r)]
      && !v2MirrorOfV1(r)
      && !variants(r.path).some(v => docOps.has(r.method + ' ' + v)));
    undocumented.map(routeKey).should.eql([], 'mounted but not documented');
  });

  it('mounts every documented operation', function () {
    const mounted = new Set(self.mounted.flatMap(r => variants(r.path).map(v => r.method + ' ' + v)));
    const phantom = documented(V1).ops.concat(documented(V3).ops)
      .filter(o => !mounted.has(o.method + ' ' + o.path));
    phantom.map(o => o.source + ' (' + o.path + ')').should.eql([], 'documented but not mounted');
  });

  it('keeps every allowed exception mounted', function () {
    const keys = new Set(self.mounted.map(routeKey));
    Object.keys(ALLOWED).filter(k => !keys.has(k)).should.eql([], 'allowed but no longer mounted');
  });

  it('keeps each swagger.json the rendering of its swagger.yaml', function () {
    for (const relative of swaggerJson.DOCUMENTS) {
      const file = path.join(ROOT, relative);
      const json = fs.readFileSync(swaggerJson.jsonFile(file), 'utf8');
      (json === swaggerJson.render(file)).should.equal(true,
        swaggerJson.jsonFile(relative) + ' is out of date; run node scripts/swagger-json.js');
    }
  });

  it('resolves every $ref in both documents', function () {
    for (const file of [V1, V3]) {
      const {doc} = documented(file);
      doc.openapi.should.match(/^3\.0\./);
      unresolvedRefs(doc).should.eql([], path.relative(ROOT, file));
    }
  });
});
