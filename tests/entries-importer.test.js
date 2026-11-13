'use strict';

const assert = require('node:assert/strict');
const {
  createNightscoutEntriesSource,
  importEntries
} = require('../lib/import/entries');

describe('one-time entries importer', function () {
  it('scans a bounded live baseline before applying history and soft-delete markers', async function () {
    const pages = [];
    const source = {
      key: 'https://source.example.org',
      async baseline ({ limit, skip }) {
        assert.equal(limit, 2);
        return skip === 0
          ? [{ _id: 'legacy-a', date: 1 }, { _id: 'legacy-b', date: 2 }]
          : [];
      },
      async history ({ cursor }) {
        if (cursor === 9000) return { docs: [{ _id: 'legacy-a', date: 1, isValid: false, srvModified: 10000 }], cursor: 10000 };
        return { docs: [], cursor };
      }
    };
    const target = { async writePage (docs) { pages.push(docs); } };

    const result = await importEntries({
      source, target, tenant: '11111111-1111-4111-8111-111111111111', pageSize: 2, now: () => 10000
    });

    assert.deepEqual(result, { baselineCount: 2, historyCount: 1, phase: 'done', cursor: 10000 });
    assert.deepEqual(pages, [
      [{ _id: 'legacy-a', date: 1 }, { _id: 'legacy-b', date: 2 }],
      [{ _id: 'legacy-a', date: 1, isValid: false, srvModified: 10000 }]
    ]);
  });

  it('can be safely rerun from the beginning after an interrupted one-shot run', async function () {
    const tenant = '11111111-1111-4111-8111-111111111111';
    const writes = [];
    let interrupted = false;
    const source = {
      key: 'https://source.example.org',
      async baseline ({ skip }) {
        if (skip === 0) return [{ _id: 'first' }];
        if (skip === 1) return [{ _id: 'second' }];
        return [];
      },
      async history ({ cursor }) { return { docs: [], cursor }; }
    };
    const target = {
      async writePage (docs) {
        writes.push(docs);
        if (docs[0]._id === 'second' && !interrupted) {
          interrupted = true;
          throw new Error('target unavailable');
        }
      }
    };
    await assert.rejects(importEntries({ source, target, tenant, pageSize: 1 }), /target unavailable/);
    const result = await importEntries({ source, target, tenant, pageSize: 1 });
    assert.equal(result.phase, 'done');
    assert.deepEqual(writes.map(page => page[0]._id), ['first', 'second', 'first', 'second']);
  });

  it('calls the precise history path and sends only the read token in Authorization', async function () {
    const requests = [];
    const source = createNightscoutEntriesSource({
      baseUrl: 'https://source.example.org',
      token: 'read-token',
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return new Response(JSON.stringify({ status: 200, result: [{ _id: 'entry', srvModified: 42 }] }), {
          status: 200, headers: { ETag: 'W/"42"', 'Content-Type': 'application/json' }
        });
      }
    });

    const result = await source.history({ limit: 50, cursor: 41 });

    assert.deepEqual(result, { docs: [{ _id: 'entry', srvModified: 42 }], cursor: 42 });
    assert.equal(requests[0].url, 'https://source.example.org/api/v3/entries/history/41?limit=50');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer read-token');
    assert.equal(requests[0].options.signal.aborted, false);
  });

  it('refuses oversized pages, duplicate textual ids and malformed history cursors', async function () {
    const tenant = '11111111-1111-4111-8111-111111111111';
    const target = { async writePage () { assert.fail('invalid page must not be written'); } };
    const source = {
      key: 'https://source.example.org',
      async baseline () { return [{ _id: 'same' }, { _id: 'same' }]; },
      async history ({ cursor }) { return { docs: [{ _id: 'entry', srvModified: 0 }], cursor }; }
    };
    await assert.rejects(importEntries({ source, target, tenant, pageSize: 2 }), { code: 'IMPORT_ID_COLLISION' });
    source.baseline = async () => [];
    await assert.rejects(importEntries({ source, target, tenant, pageSize: 2 }), { code: 'IMPORT_CURSOR_INVALID' });
    await assert.rejects(importEntries({ source, target, tenant, pageSize: 1001 }), TypeError);
  });

  it('refuses an ambiguous textual identity repeated on a later baseline page', async function () {
    let writes = 0;
    const source = {
      key: 'https://source.example.org',
      async baseline ({ skip }) { return skip === 0 || skip === 1 ? [{ _id: 'same' }] : []; },
      async history ({ cursor }) { return { docs: [], cursor }; }
    };
    const target = { async writePage () { writes++; } };
    await assert.rejects(importEntries({
      source, target, tenant: '11111111-1111-4111-8111-111111111111', pageSize: 1
    }), { code: 'IMPORT_ID_COLLISION' });
    assert.equal(writes, 1);
  });
});


describe('populated recovery value oracle (no services)', function () {
  const { oracle } = require('./fixtures/populated-recovery/lab');
  const codec = require('../lib/storage/postgres-identity');
  const fixture = require('./fixtures/populated-recovery/fixture');
  const values = () => fixture.documents().map(row => ({ tenant_id: row.tenant, ...codec.encodeDocument(row.doc) }));
  it('keeps typed twins and foreign tenant distinct regardless of row or object member order', function () {
    const expected = values();
    const actual = expected.slice().reverse().map(row => ({ doc: row.doc, id_kind: row.id_kind, tenant_id: row.tenant_id }));
    oracle(actual, expected);
    assert.equal(new Set(expected.map(row => row.tenant_id + row.id_kind + row.doc._id)).size, 3);
  });
  it('rejects missing/foreign/kind-flattened candidate values', function () {
    const expected = values();
    assert.throws(() => oracle(expected.slice(1), expected), assert.AssertionError);
    const foreign = JSON.parse(JSON.stringify(expected));
    foreign[0].tenant_id = fixture.B;
    assert.throws(() => oracle(foreign, expected), assert.AssertionError);
    const flattened = JSON.parse(JSON.stringify(expected));
    flattened[0].id_kind = 'string';
    assert.throws(() => oracle(flattened, expected), assert.AssertionError);
  });
  it('rejects array reorder and null/absent collapse while retaining nested source values', function () {
    const expected = values();
    const reordered = JSON.parse(JSON.stringify(expected));
    reordered[0].doc.extension.ordered.reverse();
    assert.throws(() => oracle(reordered, expected), assert.AssertionError);
    const absent = JSON.parse(JSON.stringify(expected));
    delete absent[0].doc.extension.nullable;
    assert.throws(() => oracle(absent, expected), assert.AssertionError);
    const source = JSON.parse(JSON.stringify(expected));
    source[0].doc.source.app = 'synthetic-wrong-source';
    assert.throws(() => oracle(source, expected), assert.AssertionError);
  });
});
