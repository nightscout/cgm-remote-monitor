'use strict';

module.exports = function output(ctx) {
  return async batch => {
    // Use Nightscout's sanitizer, upsert and data-received paths, not raw Mongo
    // writes. Stable identifiers make a partial failed batch safe to retry.
    for (const kind of ['entries', 'treatments', 'devicestatus']) {
      if (!batch[kind] || !batch[kind].length) continue;
      if (kind === 'devicestatus') {
        const missing = [];
        for (const status of batch[kind]) {
          if (!await ctx.devicestatus().findOne({ identifier: status.identifier })) missing.push(status);
        }
        batch[kind] = missing;
        if (!missing.length) continue;
      }
      await new Promise((resolve, reject) => ctx[kind].create(batch[kind], err => err ? reject(err) : resolve()));
    }
  };
};
