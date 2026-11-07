'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const create = require('./fixtures/realtime-preview/runtime-directory');
describe('owned realtime fixture runtime directory', function () {
  let capture, runtime;
  beforeEach(function () {
    capture = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-long-capture-'));
    capture = path.join(capture, 'long-' + 'a'.repeat(90)); fs.mkdirSync(capture);
  });
  afterEach(function () {
    if (runtime && fs.existsSync(runtime.path)) fs.rmSync(runtime.path, { recursive: true });
    fs.rmSync(path.dirname(capture), { recursive: true });
  });
  it('separates short0700 socket runtime from long capture and records exact empty cleanup', function () {
    runtime = create({ captureDir: capture, phaseId: 'source-only' });
    assert.notEqual(path.dirname(runtime.path), capture); assert(Buffer.byteLength(path.join(runtime.path, 'relay.sock')) < 100);
    assert.equal(fs.lstatSync(runtime.path).mode & 0o777, 0o700); runtime.close();
    const record = JSON.parse(fs.readFileSync(path.join(capture, 'consumer-runtime-directory.json')));
    assert.equal(record.captureDir, capture); assert.equal(record.absent, true); assert.equal(fs.existsSync(runtime.path), false);
  });
  it('refuses a replacement directory without deleting its owned test sentinel', function () {
    runtime = create({ captureDir: capture, phaseId: 'source-only' }); const original = runtime.path + '-original';
    fs.renameSync(runtime.path, original); fs.mkdirSync(runtime.path); fs.writeFileSync(path.join(runtime.path, 'sentinel'), 'synthetic');
    try {
      assert.throws(() => runtime.close(), /OWNERSHIP_CHANGED/);
      assert.equal(fs.readFileSync(path.join(runtime.path, 'sentinel'), 'utf8'), 'synthetic');
    } finally { fs.rmSync(runtime.path, { recursive: true }); fs.rmdirSync(original); }
  });
  it('refuses even an empty replacement directory instead of deleting its path', function () {
    runtime = create({ captureDir: capture, phaseId: 'source-only' }); const original = runtime.path + '-original';
    fs.renameSync(runtime.path, original); fs.mkdirSync(runtime.path);
    try { assert.throws(() => runtime.close(), /OWNERSHIP_CHANGED/); assert.equal(fs.existsSync(runtime.path), true); }
    finally { if (fs.existsSync(runtime.path)) fs.rmdirSync(runtime.path); fs.rmdirSync(original); }
  });
  it('refuses nonempty runtime rather than unlinking an unrecognized entry', function () {
    runtime = create({ captureDir: capture, phaseId: 'source-only' }); const file = path.join(runtime.path, 'sentinel'); fs.writeFileSync(file, 'synthetic');
    try { assert.throws(() => runtime.close(), /NONEMPTY/); assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic'); }
    finally { fs.unlinkSync(file); runtime.close(); }
  });
});
