'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const nycRequire = createRequire(require.resolve('nyc/package.json'));
const {ProcessInfo, ProcessDB} = nycRequire('istanbul-lib-processinfo');

describe('NYC process metadata contracts', function () {
  it('preserves generated IDs, saved identities and parent-child links over two cycles', async function () {
    const identifiers = new Set();
    for (let cycle = 0; cycle < 2; cycle++) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-nyc-processinfo-'));
      try {
        const parent = new ProcessInfo({files: ['parent.js'], externalId: 'owned-parent'});
        const child = new ProcessInfo({parent: parent.uuid, files: ['child.js']});
        for (const info of [parent, child]) {
          assert.match(info.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          assert.ok(!identifiers.has(info.uuid));
          identifiers.add(info.uuid);
          info.directory = directory;
          info.saveSync();
        }
        const db = new ProcessDB(directory);
        const index = await db.writeIndex();
        assert.deepEqual(index.processes[parent.uuid].children, [child.uuid]);
        assert.equal(index.processes[child.uuid].parent, parent.uuid);
        assert.deepEqual(index.files['child.js'], [child.uuid]);
        assert.equal(index.externalIds['owned-parent'].root, parent.uuid);
        const loaded = await db.readProcessInfos();
        assert.equal(loaded[parent.uuid].uuid, parent.uuid);
        assert.equal(loaded[child.uuid].uuid, child.uuid);
        assert.equal(loaded[child.uuid].parent, parent.uuid);
        loaded[child.uuid].directory = directory;
        await loaded[child.uuid].save();
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, child.uuid + '.json'))).uuid, child.uuid);
        await db.buildProcessTree();
        assert.equal(db.nodes.length, 1);
        assert.equal(db.nodes[0].nodes[0].uuid, child.uuid);
      } finally {
        fs.rmSync(directory, {recursive: true, force: true});
      }
    }
  });
});
