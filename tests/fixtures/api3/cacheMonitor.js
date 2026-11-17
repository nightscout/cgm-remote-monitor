'use strict';

const should = require('should');

/**
 * Checks that a write reached what the role keeps of it, in order.
 *
 * `single`: the cache. Every write API v3's storage wrapper passes to the
 * cache (lib/api3/storage/mongoCachedCollection) is a data-update on the bus;
 * next* take them in order and check each.
 *
 * `headless`: there is no cache, so the stored record. Each write API v3
 * announces (the storage-socket-* bus events, which the role emits with no
 * socket attached), and each write of the instance's API v1 storage modules
 * (instance.v1), is taken in order, and the stored record it names is read
 * through the collection's storage at once, before the next write can change
 * it. next* then check that record: after an update it holds the document;
 * a deleted record was there just before the delete and is now gone or soft
 * deleted.
 *
 * In both roles next* return a promise; await it.
 * @param instance
 * @constructor
 */
function CacheMonitor (instance) {

  const self = this;

  let operations = []
    , listening = false;

  function record (operation) {
    if (listening) {
      operations.push(operation);
    }
  }

  if (instance.role === 'headless') {
    watchStorage(instance, record);
  } else {
    instance.ctx.bus.on('data-update', record);
  }

  self.listen = () => {
    listening = true;
    return self;
  }

  self.stop = () => {
    listening = false;
    return self;
  }

  self.clear = () => {
    operations = [];
    return self;
  }

  self.shouldBeEmpty = () => {
    operations.length.should.equal(0)
  }

  self.nextShouldEql = async (col, doc) => {
    operations.length.should.not.equal(0)

    const operation = operations.shift();
    operation.type.should.equal(col);
    operation.op.should.equal('update');

    if (instance.role === 'headless') {
      const stored = await operation.stored;
      should.exist(stored, `stored ${col} record ${operation.key}`);
      if (doc) {
        operation.count.should.be.eql(1);
        stored.should.containEql(doc);
      }
      return;
    }

    if (doc) {
      operation.changes.should.be.Array();
      operation.changes.length.should.be.eql(1);
      const change = operation.changes[0];
      change.should.containEql(doc);
    }
  }

  self.nextShouldEqlLast = async (col, doc) => {
    await self.nextShouldEql(col, doc);
    self.shouldBeEmpty();
  }

  self.nextShouldDelete = async (col, _id) => {
    operations.length.should.not.equal(0)

    const operation = operations.shift();
    operation.type.should.equal(col);
    operation.op.should.equal('remove');

    if (instance.role === 'headless') {
      if (_id) {
        throw new Error('nextShouldDelete: checking the _id is not supported under headless');
      }
      should.exist(await operation.before, `stored ${col} record ${operation.key} before the delete`);
      const stored = await operation.stored;
      if (stored) {
        should(stored.isValid).equal(false, `stored ${col} record ${operation.key} is still valid`);
      }
      return;
    }

    if (_id) {
      operation.changes.should.equal(_id);
    }
  }

  self.nextShouldDeleteLast = async (col, _id) => {
    await self.nextShouldDelete(col, _id);
    self.shouldBeEmpty();
  }

}

// `headless`: turn each announced write into { type, op, key, count, stored },
// `stored` being the raw stored record (or null) read as soon as the write is
// announced, with _id as a string as the cache holds it. A delete also has
// `before`, the record read just before API v3's storage deleted it: "gone"
// is only evidence of a delete for a record that was there.
function watchStorage (instance, record) {

  const collections = instance.ctx.apiApp.get('collections')
    , before = new Map();

  function read (col, key) {
    return collections[col].storage.findOne(String(key), null, { normalize: false })
      .then(docs => {
        const stored = docs && docs[0];
        if (stored && stored._id) stored._id = stored._id.toString();
        return stored || null;
      });
  }

  // API v3's DELETE goes through these two (lib/api3/generic/delete):
  // deleteEveryForm when permanent, updateEveryForm to mark it deleted.
  Object.keys(collections).forEach(col => {
    const storage = collections[col].storage;
    ['deleteEveryForm', 'updateEveryForm'].forEach(name => {
      const write = storage[name];
      storage[name] = async (identifier, ...args) => {
        before.set(`${col}/${identifier}`, await read(col, identifier));
        return write(identifier, ...args);
      };
    });
  });

  function announce (type, op, key, count) {
    const stored = read(type, key);
    stored.catch(() => { }); // reported where it is awaited
    const operation = { type, op, key, count, stored };
    if (op === 'remove') {
      operation.before = before.get(`${type}/${key}`) || null;
      before.delete(`${type}/${key}`);
    }
    record(operation);
  }

  const bus = instance.ctx.bus;
  bus.on('storage-socket-create', ({ colName, doc }) => announce(colName, 'update', doc.identifier, 1));
  bus.on('storage-socket-update', ({ colName, doc }) => announce(colName, 'update', doc.identifier, 1));
  bus.on('storage-socket-delete', ({ colName, identifier }) => announce(colName, 'remove', identifier, 1));

  // API v1's storage modules (instance.v1) announce on their own bus.
  instance.v1.bus.on('data-update', ({ type, op, changes }) => {
    const list = Array.isArray(changes) ? changes : [changes];
    const first = list[0];
    const key = first && typeof first === 'object' ? first._id : first;
    announce(type, op, key, list.length);
  });
}

module.exports = CacheMonitor;
