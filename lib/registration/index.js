'use strict';

const express = require('express');

// Controller registration discovery, read-only. Serves the hub capability
// document at /.well-known/nightscout/sync and the well-known catalogue at
// /.well-known/nightscout/controllers, as the registration specification
// describes them (sections 2 and 4). Nothing is stored and no registration is
// taken: the capability document has no `submit`, `instances` or `commands`
// member, which tells a controller to keep writing today's documents.
//
// Mounted only when CONTROLLER_REGISTRATION is on (lib/server/env.js); with it
// off, both paths answer 404 as before.
//
// The catalogue under ./catalogue is generated from the specification's
// registrations; each file names its source and commit. Do not edit it by hand.

const BASE = '/.well-known/nightscout';
const API_VERSION = 'nightscout.dev/sync/v1';

// The document only changes when the server is upgraded or restarted with
// other settings, and a controller reads it at launch. An hour bounds how long
// a cache keeps a copy after such a change; the ETag lets it revalidate.
const CACHE_CONTROL = 'public, max-age=3600';

// The grammar members a hub must interpret (registration section 4). This
// slice takes no registrations, so it interprets nothing beyond them.
const INTERPRETS = [
  'apiVersion',
  'kind',
  'metadata.vendor',
  'metadata.product',
  'metadata.tier',
  'spec.cadence',
  'spec.documents.*.collection',
  'spec.documents.*.decomposesTo'
];

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

function capabilities (catalogue) {
  return {
    apiVersion: API_VERSION,
    kind: 'HubCapabilities',
    hub: { product: 'cgm-remote-monitor' },
    grammar: {
      versions: [{ apiVersion: API_VERSION, major: 1, minor: 1 }],
      interprets: INTERPRETS
    },
    // Nothing is stored yet, so no horizon class is stored and only released
    // elements would be.
    horizons: { classes: [], availability: ['released'] },
    typeFragment: { keywords: ['type'] },
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

function create () {
  const catalogue = loadCatalogue();
  const bodies = {};
  bodies[BASE + '/sync'] = JSON.stringify(capabilities(catalogue));
  bodies[BASE + '/controllers'] = JSON.stringify(index(catalogue));
  catalogue.kinds.forEach(function (kind) {
    bodies[kind.href] = JSON.stringify(kind.document);
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

  return router;
}

module.exports = create;
module.exports.BASE = BASE;
module.exports.KINDS = KINDS;
