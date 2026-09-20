'use strict';

/* What lib/server/cache.js promises its callers about the documents it hands
 * back, and what the dataloader is allowed to do with them.
 *
 * The cache has two read accessors with deliberately different contracts, and
 * the difference is a deep clone of the whole retained window — 48 h of entries,
 * 60 h of treatments, 24-48 h of device statuses. Callers pick the cheap one or
 * the safe one, so both contracts are pinned here: a change to either shows up
 * as a failing test rather than as a caller quietly mutating the cache.
 */

const should = require('should');
const { ObjectId } = require('mongodb');

const ONE_MINUTE = 60 * 1000;

function makeCache () {
  const EventEmitter = require('events');
  const env = { extendedSettings: { devicestatus: { days: 2 } } };
  const ctx = { bus: new EventEmitter(), ddata: require('../lib/data/ddata')() };
  return { cache: require('../lib/server/cache')(env, ctx), ctx: ctx };
}

function sgv (n, extra) {
  const mills = Date.now() - n * ONE_MINUTE;
  return Object.assign({
    _id: String(n).padStart(24, '0')
    , type: 'sgv'
    , sgv: 100 + n
    , date: mills
    , mills: mills
  }, extra || {});
}

function loaderFor (made, results) {
  const dataloader = require('../lib/data/dataloader');
  const lists = Object.assign({ entries: [], treatments: [], devicestatus: [], activity: [] }, results || {});
  const ctx = Object.assign({}, made.ctx, {
    settings: {}
    , language: { translate: function (v) { return v; } }
    , cache: made.cache
    , entries: { list: function (q, cb) { cb(null, lists.entries); } }
    , treatments: { list: function (q, cb) { cb(null, lists.treatments); } }
    , devicestatus: { list: function (q, cb) { cb(null, lists.devicestatus); } }
    , activity: { list: function (q, cb) { cb(null, lists.activity); } }
    , profile: { last: function (cb) { cb(null, []); } }
    , food: { list: function (cb) { cb(null, []); } }
    , store: { db: { stats: function () { return Promise.resolve({ dataSize: 1, indexSize: 1 }); } } }
  });
  const env = {
    debug: { logging: false }
    , settings: { isEnabled: function () { return false; }, units: 'mg/dl' }
    , extendedSettings: { devicestatus: { days: 2 } }
  };
  return { loader: dataloader(env, ctx), ctx: ctx };
}

function devicestatus (n) {
  const mills = Date.now() - n * ONE_MINUTE;
  return {
    _id: String(900 + n).padStart(24, '0')
    , device: 'openaps://rig'
    , created_at: new Date(mills).toISOString()
    , mills: mills
    , uploaderBattery: 88
  };
}

describe('cache read contracts', function () {

  describe('getData — a copy the caller may modify', function () {

    it('hands back documents that are not the cache\'s', function () {
      const cache = makeCache().cache;
      cache.insertData('entries', [sgv(1), sgv(2)]);

      const read = cache.getData('entries');
      read[0].sgv = 999;
      delete read[0].type;

      cache.getData('entries')[0].sgv.should.equal(101);
      cache.getData('entries')[0].type.should.equal('sgv');
    });

    it('hands back an array that is not the cache\'s', function () {
      const cache = makeCache().cache;
      cache.insertData('entries', [sgv(1), sgv(2)]);

      cache.getData('entries').reverse();

      cache.getData('entries')[0].sgv.should.equal(101);
    });
  });

  describe('getDataRef — the cheap read, and what it costs the caller', function () {

    it('hands back an array that is not the cache\'s, so it can be reordered', function () {
      const cache = makeCache().cache;
      cache.insertData('entries', [sgv(1), sgv(2)]);

      const read = cache.getDataRef('entries');
      read.reverse();
      read.pop();

      cache.getDataRef('entries').should.have.length(2);
      cache.getDataRef('entries')[0].sgv.should.equal(101);
    });

    /* This is the contract, not an accident: getDataRef exists so that a reader
     * which does not write does not pay for copies. A caller that does write
     * must use getData. If someone makes getDataRef defensive, this test fails
     * and points at the two dataloader call sites that were made cheap because
     * of it.
     */
    it('hands back the cache\'s own documents — a caller that writes, writes to the cache', function () {
      const cache = makeCache().cache;
      cache.insertData('entries', [sgv(1)]);

      cache.getDataRef('entries')[0].sgv = 999;

      cache.getData('entries')[0].sgv.should.equal(999);
    });

    it('reads the same content as getData', function () {
      const cache = makeCache().cache;
      cache.insertData('entries', [sgv(1), sgv(2)]);

      cache.getDataRef('entries').should.eql(cache.getData('entries'));
    });
  });

  describe('the API read path serves the same documents either way', function () {

    /* lib/api/entries/index.js query_models: the untyped branch reads the cache
     * and the response is cloned out of the slice. Cloning the whole retained
     * array first, as it used to, cannot change the response — assert it rather
     * than assume it, including for a document that entered the cache from the
     * data-update bus with an ObjectId _id, which is where the two reads are
     * most likely to differ.
     */
    it('a sliced-then-cloned read equals a cloned-then-sliced read', function () {
      const made = makeCache();
      made.ctx.bus.emit('data-update', {
        type: 'entries'
        , op: 'update'
        , changes: [sgv(1, { _id: new ObjectId() }), sgv(2), sgv(3)]
      });

      const count = 2;
      const sliceThenClone = JSON.parse(JSON.stringify(made.cache.getDataRef('entries').slice(0, count)));
      const cloneThenSlice = JSON.parse(JSON.stringify(made.cache.getData('entries').slice(0, count)));

      sliceThenClone.should.eql(cloneThenSlice);
      should.exist(sliceThenClone[0]._id);
      (typeof sliceThenClone[0]._id).should.equal('string');
    });
  });
});

/* A load cycle reads the whole retained window out of the cache once per
 * datatype. Two of the three call sites read it by reference, which is only
 * sound while they do not write to what they read — so what they do to those
 * documents is pinned here, not left to the next person to infer.
 */
describe('what a load cycle does to the cached documents', function () {

  it('leaves the cached entries exactly as it found them', function (done) {
    const made = makeCache();
    // the newest document carries no `mills`, which is the field the loader
    // used to write into whatever it was handed
    const noMills = sgv(1, { _id: new ObjectId() });
    delete noMills.mills;
    made.ctx.bus.emit('data-update', {
      type: 'entries'
      , op: 'update'
      , changes: [noMills, sgv(2), sgv(3)]
    });
    const before = JSON.stringify(made.cache.getDataRef('entries'));
    made.cache.getDataRef('entries')[0].should.not.have.property('mills');

    const ddata = require('../lib/data/ddata')();
    ddata.processTreatments = function () {};
    const l = loaderFor(made);

    l.loader.update(ddata, function (err) {
      should.not.exist(err);

      // no field written into a cached document ...
      JSON.stringify(made.cache.getDataRef('entries')).should.equal(before);
      // ... and the cache's own array not left reversed by the loader's reverse()
      made.cache.getDataRef('entries')[0].sgv.should.equal(101);

      // what the loader builds from those documents is unchanged: a string _id,
      // as the deep clone used to guarantee, and mills taken from date
      ddata.sgvs.should.have.length(3);
      (typeof ddata.sgvs[0]._id).should.equal('string');
      ddata.sgvs.forEach(function (s) { s.mills.should.be.a.Number(); });
      done();
    });
  });

  /* The devicestatus call site is the one that still pays for copies. It
   * rewrites uploaderBattery into uploader on every document it is handed, so
   * reading that window by reference would strip a field out of the cache — and
   * out of the next API response served from it. If someone makes this site
   * cheap like the other two, this test says what it cost.
   */
  it('does not let the devicestatus rewrite reach the cache', function (done) {
    const made = makeCache();
    made.cache.insertData('devicestatus', [devicestatus(1), devicestatus(2)]);

    const ddata = require('../lib/data/ddata')();
    ddata.processTreatments = function () {};
    const l = loaderFor(made);

    l.loader.update(ddata, function (err) {
      should.not.exist(err);

      made.cache.getDataRef('devicestatus').forEach(function (d) {
        d.should.have.property('uploaderBattery', 88);
        d.should.not.have.property('uploader');
      });
      ddata.devicestatus[0].should.have.property('uploader');
      done();
    });
  });
});

describe('documents are normalised on the way into the cache', function () {

  /* getDataRef is only interchangeable with getData because nothing
   * un-JSON-able is in the cache to begin with. The data-update bus is where
   * that could stop being true: it carries whatever the writer was holding.
   */
  it('stores an ObjectId _id and a Date the same way getData would return them', function () {
    const made = makeCache();
    const when = new Date(Date.now() - ONE_MINUTE);
    made.ctx.bus.emit('data-update', {
      type: 'treatments'
      , op: 'update'
      , changes: [{ _id: new ObjectId(), eventType: 'Note', created_at: when, mills: when.getTime() }]
    });

    const ref = made.cache.getDataRef('treatments');
    ref.should.eql(made.cache.getData('treatments'));
    (typeof ref[0]._id).should.equal('string');
    (typeof ref[0].created_at).should.equal('string');
  });

  it('stops the writer and the cache from sharing a document', function () {
    const made = makeCache();
    const written = sgv(1);
    made.ctx.bus.emit('data-update', { type: 'entries', op: 'update', changes: [written] });

    written.sgv = 999;

    made.cache.getDataRef('entries')[0].sgv.should.equal(101);
  });
});
