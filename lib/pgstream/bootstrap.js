'use strict';

// Stream coverage is established by the caller before this reconciliation.
// Each page commits durable receipt before bootstrap can report ready.
module.exports = async function reconcile (store, rows) {
  let page = [];
  for (const [tenant, row] of rows) {
    if (!row) throw new Error('PGSTREAM_BOOTSTRAP_METADATA_MISSING');
    page.push({ tenant, observed: { clock: row.signature?.stamp ?? 0, settings: row.settings ?? 0,
      policy: row.policy ?? 0, activity: row.activity.version },
    eligibility: { activity: !row.activity.paused && !row.activity.suspended } });
    if (page.length === 64) { await store.observeMany(page); page = []; }
  }
  if (page.length) await store.observeMany(page);
};
