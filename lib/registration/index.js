'use strict';

const express = require('express');

// Controller registration (the registration specification). Serves the hub
// capability document at /.well-known/nightscout/sync, the well-known
// catalogue at /.well-known/nightscout/controllers (sections 2 and 4) and,
// when the registration store is set up (ctx.registrations), the product
// resource at SUBMIT_HREF (sections 5-6, ./products.js).
//
// Mounted only when CONTROLLER_REGISTRATION is on (lib/server/env.js); with it
// off, every path answers 404 as before.
//
// The catalogue under ./catalogue is generated from the specification's
// registrations; each file names its source and commit. Do not edit it by hand.

const BASE = '/.well-known/nightscout';
const API_VERSION = 'nightscout.dev/sync/v1';

// The document only changes when the server is upgraded or restarted with
// other settings, and a controller reads it at launch. An hour bounds how long
// a cache keeps a copy after such a change; the ETag lets it revalidate.
const CACHE_CONTROL = 'public, max-age=3600';

const SUBMIT_HREF = '/api/v4/registrations';

// The hub evaluates every member of the grammar when it takes a registration
// (registration section 5.3), so it interprets the whole of it.
const INTERPRETS = ['apiVersion', 'kind', 'metadata', 'spec'];

function vendoredKinds () {
  return {
    androidaps: require('./catalogue/androidaps.json'),
    loop: require('./catalogue/loop.json'),
    trio: require('./catalogue/trio.json')
  };
}

const KINDS = Object.keys(vendoredKinds());

function loadCatalogue () {
  const vendoredById = vendoredKinds();
  const kinds = KINDS.map(function (id) {
    const vendored = vendoredById[id];
    return {
      id: id,
      vendor: vendored.document.metadata.vendor,
      product: vendored.document.metadata.product,
      href: BASE + '/controllers/' + id,
      document: vendored.document
    };
  });
  const slots = require('./catalogue/shared-slots.json').slots.map(function (slot) {
    return { name: slot.name };
  });
  const mappings = require('./catalogue/mappings.json').mappings;
  return { kinds, slots, mappings };
}

function listing (kind) {
  return { id: kind.id, vendor: kind.vendor, product: kind.product, href: kind.href };
}

function capabilities (catalogue, offers) {
  const doc = {
    apiVersion: API_VERSION,
    kind: 'HubCapabilities',
    hub: { product: 'cgm-remote-monitor' },
    grammar: {
      versions: [{ apiVersion: API_VERSION, major: 1, minor: 1 }],
      interprets: INTERPRETS
    },
    horizons: {
      classes: ['cycle', 'span', 'effective-dated', 'definition', 'aggregate'],
      availability: ['released', 'dev-only', 'experimental']
    },
    typeFragment: {
      keywords: ['type', 'enum', 'minimum', 'maximum', 'format', 'items', 'properties', 'required', 'description']
    },
    limits: {
      maxRegistrationBytes: 65536,
      maxExtensions: 8,
      maxFieldsPerExtension: 32,
      maxTypeDepth: 4
    },
    wellKnown: {
      catalogue: BASE + '/controllers',
      kinds: catalogue.kinds.map(listing),
      slots: catalogue.slots,
      mappings: catalogue.mappings
    }
  };
  if (offers.submit) {
    doc.submit = {
      href: SUBMIT_HREF,
      tiers: ['controller-owned'],
      permissions: { submit: 'api:registrations:create', retire: 'api:registrations:delete' }
    };
  }
  return doc;
}

function index (catalogue) {
  return {
    apiVersion: API_VERSION,
    kind: 'WellKnownCatalogue',
    kinds: catalogue.kinds.map(listing),
    slots: catalogue.slots,
    mappings: catalogue.mappings
  };
}

// `options` is for the conformance harness, which runs each case against
// the capability document and well-known registrations the case states:
// { capabilities, wellKnown: { href: registration } }. The server passes none.
function create (env, ctx, options) {
  options = options || {};
  const catalogue = loadCatalogue();
  const offers = { submit: Boolean(ctx && ctx.registrations) };
  const caps = options.capabilities || capabilities(catalogue, offers);
  const wellKnown = options.wellKnown || {};
  if (!options.wellKnown) {
    catalogue.kinds.forEach(function (kind) { wellKnown[kind.href] = kind.document; });
  }

  const bodies = {};
  bodies[BASE + '/sync'] = JSON.stringify(caps);
  bodies[BASE + '/controllers'] = JSON.stringify(index(catalogue));
  Object.keys(wellKnown).forEach(function (href) {
    if (href.indexOf(BASE + '/controllers/') === 0) { bodies[href] = JSON.stringify(wellKnown[href]); }
  });

  const router = express.Router({ caseSensitive: true, strict: true });

  function send (body) {
    return function (req, res) {
      // A request that carried a credential was already marked no-store
      // (lib/middleware/credential-cache.js); keep that.
      if (!res.get('Cache-Control')) {
        res.set('Cache-Control', CACHE_CONTROL);
      }
      res.type('application/json');
      res.send(body);
    };
  }

  Object.keys(bodies).forEach(function (path) {
    router.get(path, send(bodies[path]));
  });

  if (caps.submit && ctx && ctx.registrations) {
    router.use(caps.submit.href, require('./products')(env, ctx, { capabilities: caps, wellKnown: wellKnown }));
  }

  return router;
}

module.exports = create;
module.exports.BASE = BASE;
module.exports.KINDS = KINDS;
module.exports.SUBMIT_HREF = SUBMIT_HREF;
module.exports.capabilities = function (offers) { return capabilities(loadCatalogue(), offers || {}); };
