'use strict;'

function clearRequireCache () {
  Object.keys(require.cache).forEach(function(key) {
    delete require.cache[key];
  });
}

exports.mochaHooks = {
  afterEach (done) {
    clearRequireCache();
    done();
  }
};
