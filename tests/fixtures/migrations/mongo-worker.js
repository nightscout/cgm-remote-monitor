'use strict';

const { Collection } = require('mongodb');
const { run } = require('../../../lib/migrations/mongodb');

async function checkpoint (name) {
  process.send({ checkpoint: name });
  await new Promise(resolve => process.once('message', resolve));
}

process.once('message', async ({ opts, pause }) => {
  const findOne = Collection.prototype.findOne;
  const updateMany = Collection.prototype.updateMany;
  Collection.prototype.findOne = async function (filter, options) {
    if (pause === 'before-fence' && filter._id === 'lease' && options && options.session) {
      pause = null;
      await checkpoint('before-fence');
    }
    const result = await findOne.call(this, filter, options);
    if (pause === 'after-lease' && filter._id === 'lease' && options && options.session) {
      pause = null;
      await checkpoint('after-lease');
    }
    return result;
  };
  Collection.prototype.updateMany = async function (...args) {
    process.send({ dataAttempt: true });
    const result = await updateMany.apply(this, args);
    if (pause === 'after-data') {
      pause = null;
      await checkpoint('after-data');
    }
    return result;
  };
  try {
    const result = await run('up', opts);
    if (pause === 'after-commit') await checkpoint('after-commit');
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    let cause = error;
    while (cause.cause) cause = cause.cause;
    process.send({ error: cause.code || 'MIG_FAILED' }, () => process.disconnect());
  }
});
