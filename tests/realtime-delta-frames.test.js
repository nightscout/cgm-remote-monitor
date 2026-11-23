'use strict';

// Decision no-realtime-fast-path: realtime sends the evaluator's frame as a
// delta against the frame each socket last received (single-site calcDelta),
// and a full frame where a single site cannot express the change or the base
// is not known. The browser's own merge (lib/client/receiveddata.js) applied
// to every frame must leave the data the full frame describes.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const protocolFactory = require('../lib/server/realtime/protocol');
const receiveDData = require('../lib/client/receiveddata');
const A = '11111111-1111-4111-8111-111111111111';
const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
class Socket extends EventEmitter {
  constructor (host) { super(); this.request = { headers: { host }, rawHeaders: ['Host', host], socket: {} }; this.sent = []; this.rooms = new Set(['self']); this.id = 'self'; }
  emit (event, value) { this.sent.push({ event, value: value === undefined ? value : JSON.parse(JSON.stringify(value)) }); return true; }
  async receive (event, ...args) { return Promise.all(this.listeners(event).map(fn => fn(...args))); }
  join (name) { this.rooms.add(name); }
  leave (name) { this.rooms.delete(name); }
  disconnect () { this.disconnected = true; super.emit('disconnect'); }
  frames () { return this.sent.filter(row => row.event === 'dataUpdate').map(row => row.value); }
}
const now = Date.now();
const sgv = (i, mgdl = 100 + i) => ({ _id: 'e' + i, mgdl, mills: now - (20 - i) * 300000, type: 'sgv' });
const note = (id, i, extra = {}) => ({ _id: id, eventType: 'Note', mills: now - (20 - i) * 300000, created_at: new Date(now - (20 - i) * 300000).toISOString(), ...extra });
function publication (checkpoint, { sgvs, treatments = [], devicestatus = [], profiles = [{ _id: 'p', defaultProfile: 'Default', store: {} }] }, identity = 'same') {
  return Object.freeze({ tenant: A, checkpoint, identity, frame: { delta: false, lastUpdated: now + checkpoint, sgvs, cals: [], mbgs: [], food: [], treatments, devicestatus, profiles } });
}
async function fixture (first) {
  let published = first;
  const protocol = protocolFactory.create({
    admission: { resolve: async () => A }, readCurrent: async tenant => ({ tenant, identity: 'same', env }), domains: ['entries'],
    runtime: () => ({ refresh: async () => published, last: () => published }),
    api: { executeSocketMutation: async () => ({}), authorizeSocket: async () => ({ permissions: { read: true, write: true, write_treatment: true, ack: true }, collections: ['entries'] }) } });
  return {
    protocol,
    publish (next) { published = next; },
    async socket (message = { secret: 'synthetic' }) {
      const socket = new Socket('a.test'); await protocol.prepare(socket); protocol.bind(socket, '/');
      await socket.receive('authorize', message); return socket;
    }
  };
}
// The browser: an empty ddata that receives every frame the socket was sent.
function browser (frames) {
  const ddata = { sgvs: [], mbgs: [], cals: [], treatments: [], food: [], devicestatus: [], processTreatments () {} };
  for (const frame of frames) receiveDData(JSON.parse(JSON.stringify(frame)), ddata, { extendedSettings: { devicestatus: { advanced: true } } });
  return ddata;
}
const shown = ddata => ({ sgvs: ddata.sgvs.map(row => row._id + ':' + row.mgdl), treatments: ddata.treatments.map(row => row._id + ':' + (row.notes || '')).sort() });

describe('realtime delta frames (decision no-realtime-fast-path)', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  const p1 = publication(1, { sgvs: [sgv(1), sgv(2)], treatments: [note('t1', 1), note('t2', 2)] });
  const p2 = publication(2, { sgvs: [sgv(1), sgv(2), sgv(3)], treatments: [note('t1', 1, { notes: 'edited' }), note('t3', 3)] });
  const p3 = publication(3, { sgvs: [sgv(1), sgv(2), sgv(3), sgv(4)], treatments: [note('t1', 1, { notes: 'edited' }), note('t3', 3), note('t4', 4)] });

  it('RT_DELTA: a socket holding the previous frame is sent the single-site delta, and its browser shows the full frame', async function () {
    const f = await fixture(p1);
    const socket = await f.socket();
    await f.protocol.fanout({ tenant: A, previous: p1, next: p2 });
    const [full, delta] = socket.frames();
    assert.equal(full.delta, false, 'RT_DELTA_PRIME a new socket is sent the full frame');
    assert.equal(delta.delta, true, 'RT_DELTA_SENT');
    assert.deepEqual(delta.sgvs.map(row => row._id), ['e3'], 'only the new reading');
    assert.deepEqual(delta.treatments.map(row => [row._id, row.action || 'add']).sort(), [['t1', 'update'], ['t2', 'remove'], ['t3', 'add']]);
    assert.equal(delta.profiles, undefined, 'unchanged profiles are not resent');
    assert.deepEqual(shown(browser(socket.frames())), shown(browser([p2.frame])), 'RT_DELTA_PARITY');
    assert.equal(f.protocol.stats().deltaFrames, 1);
  });

  it('RT_DELTA_OWN_BASE: a socket that missed a publication is sent the delta from the frame it holds', async function () {
    const f = await fixture(p1);
    const socket = await f.socket();
    // p2 was published without reaching this socket (previous names p2).
    await f.protocol.fanout({ tenant: A, previous: p2, next: p3 });
    assert.deepEqual(socket.frames()[1].sgvs.map(row => row._id), ['e3', 'e4']);
    assert.deepEqual(shown(browser(socket.frames())), shown(browser([p3.frame])), 'RT_DELTA_DROPPED_REVISION');
  });

  it('RT_DELTA_WITHDRAWN: a fanout withdrawn before the broadcast leaves the base where it was', async function () {
    const f = await fixture(p1);
    const socket = await f.socket();
    socket.id = 's1'; const emitted = [];
    socket.nsp = { to: () => ({ emit: (event, value) => emitted.push(value) }) };
    let checks = 0;
    await assert.rejects(f.protocol.fanout({ tenant: A, previous: p1, next: p2, assertCurrent: () => { if (++checks === 3) throw new Error('WITHDRAWN'); } }), /WITHDRAWN/);
    assert.equal(emitted.length, 0);
    delete socket.nsp;
    await f.protocol.fanout({ tenant: A, previous: p2, next: p3 });
    assert.deepEqual(socket.frames()[1].sgvs.map(row => row._id), ['e3', 'e4'], 'RT_DELTA_BASE_MOVES_ON_SEND');
    assert.deepEqual(shown(browser(socket.frames())), shown(browser([p3.frame])));
  });

  it('RT_DELTA_FULL: out-of-order, settings identity change, a removed reading and a new socket get full frames', async function () {
    const f = await fixture(p2);
    const socket = await f.socket();
    await f.protocol.fanout({ tenant: A, previous: p2, next: p1 });
    assert.equal(socket.frames()[1].delta, false, 'RT_DELTA_OUT_OF_ORDER');
    const removed = publication(4, { sgvs: [sgv(1)], treatments: p1.frame.treatments });
    await f.protocol.fanout({ tenant: A, previous: p1, next: removed });
    assert.equal(socket.frames()[2].delta, false, 'RT_DELTA_REMOVED_READING calcDelta cannot remove an entry');
    const other = publication(5, { sgvs: [sgv(1), sgv(2), sgv(5)], treatments: p1.frame.treatments }, 'other');
    await assert.rejects(f.protocol.fanout({ tenant: A, previous: removed, next: other }), /REALTIME_CYCLE_CHANGED/);
    assert.equal(protocolFactory.deltaFrame(removed, other), null, 'RT_DELTA_IDENTITY');
    f.publish(p3); const late = await f.socket();
    assert.equal(late.frames()[0].delta, false);
    assert.deepEqual(shown(browser(socket.frames())), shown(browser([removed.frame])));
  });

  it('RT_DELTA_REMOVED_WITH_ADD: a reading removed in the same cycle as an addition is sent as a full frame', async function () {
    const f = await fixture(p2);
    const socket = await f.socket();
    const next = publication(3, { sgvs: [sgv(1), sgv(3), sgv(4)], treatments: p2.frame.treatments });
    await f.protocol.fanout({ tenant: A, previous: p2, next });
    assert.equal(socket.frames()[1].delta, false, 'RT_DELTA_REMOVED_READING_FULL');
    assert.deepEqual(shown(browser(socket.frames())), shown(browser([next.frame])));
    // The window moving past old readings is not a delete.
    const slid = publication(4, { sgvs: [sgv(3), sgv(4), sgv(5)], treatments: p2.frame.treatments });
    await f.protocol.fanout({ tenant: A, previous: next, next: slid });
    assert.equal(socket.frames()[2].delta, true, 'RT_DELTA_WINDOW_SLIDE');
  });

  it('RT_DELTA_DUPLICATE: a repeated publication sends nothing', async function () {
    const f = await fixture(p1);
    const socket = await f.socket();
    await f.protocol.fanout({ tenant: A, previous: p1, next: p2 });
    await f.protocol.fanout({ tenant: A, previous: p1, next: p2 });
    await f.protocol.fanout({ tenant: A, previous: p2, next: p2 });
    assert.equal(socket.frames().length, 2);
    assert.deepEqual(shown(browser(socket.frames())), shown(browser([p2.frame])));
  });

  it('RT_DELTA_STATUS: status rides a delta only on a profile switch, as a single site sends it', async function () {
    const f = await fixture(p1);
    const socket = await f.socket({ secret: 'synthetic', status: true });
    assert.ok(socket.frames()[0].status, 'full frames carry status');
    await f.protocol.fanout({ tenant: A, previous: p1, next: p2 });
    assert.equal(socket.frames()[1].status, undefined, 'no switch, no status');
    const switched = publication(3, { sgvs: p2.frame.sgvs, treatments: [...p2.frame.treatments, note('s1', 3, { eventType: 'Profile Switch', profile: 'Night' })] });
    await f.protocol.fanout({ tenant: A, previous: p2, next: switched });
    assert.equal(socket.frames()[2].delta, true);
    assert.ok(socket.frames()[2].status, 'RT_DELTA_PROFILE_SWITCH_STATUS');
  });
});
