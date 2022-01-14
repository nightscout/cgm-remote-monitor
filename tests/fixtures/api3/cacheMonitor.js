'use strict';

/**
 * Cache monitoring mechanism for tracking and checking cache updates.
 * @param instance
 * @constructor
 */
function CacheMonitor (instance) {

  const self = this;

  let operations = []
    , listening = false;

  instance.ctx.bus.on('data-update', operation => {
    if (listening) {
      operations.push(operation);
    }
  });

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

  self.nextShouldEql = (col, doc) => {
    operations.length.should.not.equal(0)

    const operation = operations.shift();
    operation.type.should.equal(col);
    operation.op.should.equal('update');

    if (doc) {
      operation.changes.should.be.Array();
      operation.changes.length.should.be.eql(1);
      const change = operation.changes[0];
      change.should.containEql(doc);
    }
  }

  self.nextShouldEqlLast = (col, doc) => {
    self.nextShouldEql(col, doc);
    self.shouldBeEmpty();
  }

  self.nextShouldDelete = (col, _id) => {
    operations.length.should.not.equal(0)

    const operation = operations.shift();
    operation.type.should.equal(col);
    operation.op.should.equal('remove');

    if (_id) {
      operation.changes.should.equal(_id);
    }
  }

  self.nextShouldDeleteLast = (col, _id) => {
    self.nextShouldDelete(col, _id);
    self.shouldBeEmpty();
  }

}

module.exports = CacheMonitor;
