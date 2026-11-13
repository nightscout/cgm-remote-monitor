'use strict';

// Private operator checkout bridge. pg-pool removes its idle error listener
// while a client is borrowed; Vault awaits must still observe first failure.
// This owns no Ready/EOF/credit judgement: release(error) goes to the real pool.
function watch (client) {
  let first;
  const capture = error => { first = first || error || new Error('operator client ended'); };
  const ended = () => capture(new Error('operator client ended'));
  client.on('error',capture); client.on('end',ended);
  const check = () => { if (first) throw first; };
  const run = async fn => {
    check();
    let value;
    try { value = await fn(); } catch (error) { check(); throw error; }
    check(); return value;
  };
  return {
    get processID () { return client.processID; },
    query: (...args) => run(() => client.query(...args)), run, check,
    get error () { return first; },
    release (failure) {
      // Keep our listener through release, when pg-pool reinstalls its own.
      try { client.release(first || failure); }
      finally { client.removeListener('error',capture); client.removeListener('end',ended); }
      if (!failure) check();
    }
  };
}
function checkout (pool) {
  return new Promise((resolve,reject) => {
    pool.connect((error,client) => {
      if (error) { reject(error); return; }
      resolve(watch(client)); // listener installed before resolving the checkout
    });
  });
}
module.exports = { checkout };
