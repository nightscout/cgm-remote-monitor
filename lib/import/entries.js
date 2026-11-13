'use strict';

const entriesWrite = require('../storage/postgres-entries-write');
const { fromMongo } = require('../storage/filter');

const MAX_PAGE_SIZE = 1000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 1000000;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function pageSize (value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new TypeError('Entries import page size must be between 1 and ' + MAX_PAGE_SIZE);
  }
  return value;
}

function jsonDocument (doc) {
  if (!doc || Object.getPrototypeOf(doc) !== Object.prototype ||
      typeof doc._id !== 'string' || !doc._id || Buffer.byteLength(doc._id, 'utf8') > 256 ||
      doc._id.includes('\0')) {
    throw failure('IMPORT_DOCUMENT_INVALID');
  }
  return { ...doc, _id: String(doc._id) };
}

function pageDocuments (docs, limit) {
  if (!Array.isArray(docs) || docs.length > limit) throw failure('IMPORT_PAGE_INVALID');
  const ids = new Set();
  return docs.map(doc => {
    const normalized = jsonDocument(doc);
    if (ids.has(normalized._id)) throw failure('IMPORT_ID_COLLISION');
    ids.add(normalized._id);
    return normalized;
  });
}

function responseCursor (response, docs, current) {
  const etag = response.headers.get('etag');
  const match = typeof etag === 'string' && /^W\/"([0-9]+)"$/.exec(etag);
  const cursor = match ? Number(match[1]) : Math.max(...docs.map(doc => doc.srvModified));
  if (!Number.isSafeInteger(cursor) || cursor <= current) throw failure('IMPORT_CURSOR_INVALID');
  return cursor;
}

async function responseJson (response) {
  if (!response.ok) throw failure('IMPORT_SOURCE_HTTP_' + response.status);
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_RESPONSE_BYTES) throw failure('IMPORT_SOURCE_RESPONSE_TOO_LARGE');
  if (!response.body) throw failure('IMPORT_SOURCE_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (done) break;
      const { value } = result;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw failure('IMPORT_SOURCE_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('IMPORT_SOURCE_RESPONSE_INVALID'); }
  if (!body || !Array.isArray(body.result)) throw failure('IMPORT_SOURCE_RESPONSE_INVALID');
  return body.result;
}

function createNightscoutEntriesSource ({ baseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError('Entries import requires a source URL'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/' ||
      (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new TypeError('Entries import source must be an HTTPS origin (HTTP is limited to loopback)');
  }
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token) || typeof fetchImpl !== 'function') {
    throw new TypeError('Entries import requires a read-scoped token and fetch implementation');
  }
  async function get (pathname, query) {
    const url = new URL(pathname, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000)
      });
    } catch { throw failure('IMPORT_SOURCE_UNAVAILABLE'); }
    return { response, docs: await responseJson(response) };
  }
  return Object.freeze({
    key: base.origin,
    async baseline ({ limit, skip }) {
      const result = await get('/api/v3/entries', { limit, skip });
      return result.docs;
    },
    async history ({ limit, cursor }) {
      const result = await get('/api/v3/entries/history/' + cursor, { limit });
      const docs = pageDocuments(result.docs, limit);
      return { docs, cursor: docs.length ? responseCursor(result.response, docs, cursor) : cursor };
    }
  });
}

function createPostgresTarget ({ connection, tenant, table = 'entries' } = {}) {
  if (!connection || typeof connection.withTenant !== 'function' ||
      typeof tenant !== 'string' || !TENANT.test(tenant)) {
    throw new TypeError('Entries import target requires a tenant-bound PostgreSQL connection');
  }
  const writer = entriesWrite({ connection, table });
  return Object.freeze({
    async writePage (docs) {
      if (!Array.isArray(docs) || docs.length > MAX_PAGE_SIZE) throw failure('IMPORT_PAGE_INVALID');
      if (!docs.length) return;
      const operations = docs.map(doc => ({
        filter: fromMongo({ _id: doc._id }),
        doc
      }));
      await connection.withTenant(tenant, () => writer.bulkUpsert(operations, { mode: 'replace' }));
    }
  });
}

async function importEntries ({ source, target, tenant, pageSize: requestedPageSize = 100, now = Date.now } = {}) {
  if (!source || typeof source.key !== 'string' ||
      typeof source.baseline !== 'function' || typeof source.history !== 'function' ||
      !target || typeof target.writePage !== 'function' ||
      typeof tenant !== 'string' || !TENANT.test(tenant) || typeof now !== 'function') {
    throw new TypeError('Entries import requires source, target and tenant services');
  }
  const limit = pageSize(requestedPageSize);
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 1) throw new TypeError('Entries import clock is invalid');
  const state = { phase: 'baseline', offset: 0, cursor: Math.max(0, startedAt - 1000) };
  let baselineCount = 0;
  let historyCount = 0;
  const baselineIds = new Set();
  while (state.phase === 'baseline') {
    const docs = pageDocuments(await source.baseline({ limit, skip: state.offset }), limit);
    if (docs.length) {
      if (baselineCount + historyCount + docs.length > MAX_IMPORT_RECORDS) throw failure('IMPORT_RESOURCE_LIMIT');
      for (const doc of docs) {
        if (baselineIds.has(doc._id)) throw failure('IMPORT_ID_COLLISION');
        baselineIds.add(doc._id);
      }
      await target.writePage(docs);
      baselineCount += docs.length;
      state.offset += docs.length;
      if (!Number.isSafeInteger(state.offset)) throw failure('IMPORT_OFFSET_INVALID');
    }
    if (docs.length < limit) state.phase = 'history';
  }
  while (state.phase === 'history') {
    const result = await source.history({ limit, cursor: state.cursor });
    const docs = pageDocuments(result.docs, limit);
    if (!docs.length) {
      state.phase = 'done';
      break;
    }
    if (!Number.isSafeInteger(result.cursor) || result.cursor <= state.cursor) {
      throw failure('IMPORT_CURSOR_INVALID');
    }
    if (baselineCount + historyCount + docs.length > MAX_IMPORT_RECORDS) throw failure('IMPORT_RESOURCE_LIMIT');
    await target.writePage(docs);
    historyCount += docs.length;
    state.cursor = result.cursor;
  }
  return { baselineCount, historyCount, phase: state.phase, cursor: state.cursor };
}

module.exports = {
  MAX_PAGE_SIZE,
  createNightscoutEntriesSource,
  createPostgresTarget,
  importEntries
};
