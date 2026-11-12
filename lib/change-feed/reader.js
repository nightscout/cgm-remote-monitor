'use strict';
const { randomUUID } = require('node:crypto');
const { decode } = require('./pgoutput');
// Serial batches. Slot progress is never acknowledged until the notification
// transaction commits. Notification/ACK failure retries; duplicates are harmless.
function create ({ config, store, reconnect, now = Date.now, rss = () => process.memoryUsage().rss,
  schedule = setTimeout, cancel = clearTimeout, alert = code => console.warn('Feed reader alert',code) }) {
  let closed = false, timer, pending, lastHeartbeat = 0, lastSuccess = null, refusal = null;
  const generation = randomUUID(), counters = { batches: 0, messages: 0, hints: 0, refusals: 0 };
  function pass () {
    if (closed) return Promise.resolve(); if (pending) return pending;
    pending = (async () => {
      try {
        if (!store && reconnect) store = await reconnect();
        if (rss() > config.rssRefuseBytes) throw Object.assign(new Error('FEED_RSS_REFUSED'),{ code: 'FEED_RSS_REFUSED' });
        const batch = decode(await store.peek(),config);
        const heartbeat = now() - lastHeartbeat >= config.heartbeatMs;
        const payloads = [...batch.hints].map(([t,k]) => ({ v: 1, t, k }));
        if (payloads.length) await store.notify(payloads);
        if (batch.upto) {
          const advanced = await store.advance(batch.upto);
          if (advanced !== batch.upto) throw Object.assign(new Error('FEED_ACK_UNCERTAIN'),{ code: 'FEED_ACK_UNCERTAIN' });
        }
        if (heartbeat) { await store.notify([{ v: 1, k: 'heartbeat', reader: generation }]); lastHeartbeat = now(); }
        counters.batches++; counters.messages += batch.messages; counters.hints += batch.hints.size;
        refusal = null; lastSuccess = now();
      } catch (error) {
        if (reconnect && !/^FEED_/.test(error?.code || '')) { await store?.close().catch(() => {}); store = null; }
        counters.refusals++; const code = /^FEED_[A-Z_]+$/.test(error?.code || '') ? error.code : 'FEED_READER_REFUSED';
        if (refusal !== code) { refusal = code; try { alert(code); } catch { /* alert sink cannot acknowledge a batch */ } }
      }
    })().finally(() => { pending = null; });
    return pending;
  }
  function arm () { if (!closed) timer = schedule(async () => { await pass(); arm(); },config.pollMs); }
  return Object.freeze({ pass,
    start () { if (timer || closed) return; arm(); },
    health: () => ({ live: !closed, ready: !closed && lastSuccess !== null && refusal === null,
      degraded: refusal !== null, refusal, generation, lastSuccess, ...counters }),
    async close () { if (closed) return; closed = true; cancel(timer); await pending; await store?.close(); } });
}
async function boot (config) {
  const store = await require('./postgres').create(config);
  const reader = create({ config,store,reconnect: () => require('./postgres').create(config) });
  await reader.pass(); reader.start();
  return Object.freeze({ close: reader.close, health: reader.health });
}
module.exports = { create, boot };
