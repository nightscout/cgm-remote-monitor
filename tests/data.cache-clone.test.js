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
