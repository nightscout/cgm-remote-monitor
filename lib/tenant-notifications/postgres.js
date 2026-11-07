'use strict';

const { randomUUID } = require('node:crypto');
const scope = require('../storage/tenant-scope');
const c = require('./contract');
const assertReady = require('./readiness');

module.exports = function notificationStore ({ connection, namespace, maxRows, maxBytes } = {}) {
  if (!connection || typeof connection.transaction !== 'function' || typeof connection.query !== 'function' ||
      typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace === 'public' ||
      namespace.startsWith('pg_') || namespace === 'information_schema') throw new TypeError('Explicit notification transaction/schema required');
  c.integer(maxRows, 'maxRows'); c.integer(maxBytes, 'maxBytes');
  const requests = '"' + namespace + '".tenant_notification_requests', heads = '"' + namespace + '".tenant_notification_heads';
  const bind = tenant => {
    c.tenant(tenant);
    if (scope.requireTenant('notification store') !== tenant) throw new Error('NOTIFICATION_TENANT_MISMATCH');
  };
  const bounded = rows => {
    if (rows.length > maxRows || Buffer.byteLength(JSON.stringify(rows)) > maxBytes) throw new Error('NOTIFICATION_READ_BOUND');
    return rows;
  };
  const tx = (tenant, fn) => {
    bind(tenant);
    return connection.transaction(async () => {
      await assertReady(connection, namespace);
      return fn();
    });
  };
  const one = async (tenant, id, lock = false) => (await connection.query('SELECT * FROM ' + requests +
    ' WHERE tenant_id=$1 AND request_id=$2' + (lock ? ' FOR UPDATE' : ''), [tenant, id])).rows[0];
  // Admission, attempt and completion all acquire head before request, avoiding
  // opposite lock orders when a retry completes as a new effect is admitted.
  async function locked (tenant, id) {
    const observed = await one(tenant, id);
    if (!observed) return {};
    const head = (await connection.query('SELECT * FROM ' + heads + ' WHERE tenant_id=$1 AND consumer=$2 AND dedup_key=$3 FOR UPDATE',
      [tenant, observed.consumer, observed.dedup_key])).rows[0];
    if (!head) throw new Error('NOTIFICATION_HEAD_MISSING');
    const saved = await one(tenant, id, true);
    return head.request_id === id ? { head, saved } : {};
  }
  return Object.freeze({
    ready (tenant) { return tx(tenant, async () => true); },
    async enqueue ({ tenant, consumer, key, origin, configIdentity, payload, at }) {
      c.instant(at); c.instant(at + c.SHORT); if (typeof consumer !== 'string' || !c.NAME.test(consumer)) throw new TypeError('Explicit notification consumer required');
      c.text(key, 'dedup key'); c.text(origin, 'origin'); c.text(configIdentity, 'config identity');
      if (Buffer.byteLength(JSON.stringify(payload)) > maxBytes) throw new Error('NOTIFICATION_PAYLOAD_BOUND');
      return tx(tenant, async () => {
        await connection.query('INSERT INTO ' + heads + ' (tenant_id,consumer,dedup_key,blocked_until) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING', [tenant, consumer, key]);
        const head = (await connection.query('SELECT * FROM ' + heads + ' WHERE tenant_id=$1 AND consumer=$2 AND dedup_key=$3 FOR UPDATE', [tenant, consumer, key])).rows[0];
        if (!head) throw new Error('NOTIFICATION_HEAD_MISSING');
        if (head.request_id) {
          const saved = await one(tenant, head.request_id, true);
          if (!saved) throw new Error('NOTIFICATION_REQUEST_MISSING');
          const active = ['pending', 'attempting', 'uncertain'].includes(saved.state);
          const same = c.sameEffect(saved.payload, payload);
          // A retry of the SAME immutable delivery payload retains its UUID.
          if (same && (saved.origin === origin || active)) return saved;
          // Legacy cache equality is still inside the normal suppression window.
          if (!saved.payload.clear && Number(head.blocked_until) >= at) return saved;
          // A changed current effect can be admitted now, without rewriting the old
          // identity/payload or allowing its late completion to update the new head.
          if (active) await connection.query('UPDATE ' + requests +
            ' SET state=\'cancelled\' WHERE tenant_id=$1 AND request_id=$2', [tenant, saved.request_id]);
        }
        const id = randomUUID();
        const inserted = await connection.query('INSERT INTO ' + requests +
          ' (tenant_id,request_id,consumer,dedup_key,origin,config_identity,payload,state,created_at,next_at,attempt) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,\'pending\',$8,$8,0) RETURNING *',
        [tenant, id, consumer, key, origin, configIdentity, JSON.stringify(payload), at]);
        await connection.query('UPDATE ' + heads + ' SET request_id=$4,blocked_until=$5 WHERE tenant_id=$1 AND consumer=$2 AND dedup_key=$3',
          [tenant, consumer, key, id, at + (payload.clear ? 0 : c.SHORT)]);
        return inserted.rows[0];
      }); // transaction resolves only after COMMIT; never enqueue inside another transaction.
    },
    async due ({ tenant, consumer, at }) {
      c.instant(at);
      return tx(tenant, async () => bounded((await connection.query('SELECT * FROM ' + requests +
        ' WHERE tenant_id=$1 AND consumer=$2 AND ((state IN (\'pending\',\'uncertain\') AND next_at <= $3) OR (state=\'attempting\' AND attempt_until <= $3)) ORDER BY created_at,request_id LIMIT $4',
      [tenant, consumer, at, maxRows + 1])).rows));
    },
    async begin ({ tenant, id, at, until }) {
      c.instant(at); c.instant(until); if (until <= at) throw new TypeError('Notification attempt deadline must advance');
      return tx(tenant, async () => {
        const { saved, head } = await locked(tenant, id);
        if (!saved || ['accepted', 'cancelled'].includes(saved.state) || Number(saved.next_at) > at ||
            (saved.attempt > 0 && !saved.payload.clear && Number(head.blocked_until) >= at) ||
            (saved.state === 'attempting' && Number(saved.attempt_until) > at)) return null;
        const token = randomUUID();
        return (await connection.query('UPDATE ' + requests +
          ' SET state=\'attempting\',attempt=attempt+1,attempt_token=$3,attempt_until=$4 WHERE tenant_id=$1 AND request_id=$2 RETURNING *',
        [tenant, id, token, until])).rows[0];
      });
    },
    async dispatch ({ tenant, id, token, at, until }) {
      c.instant(at); c.instant(at + c.SHORT); c.instant(until);
      if (until <= at) throw new TypeError('Notification dispatch deadline must advance');
      return tx(tenant, async () => {
        const { saved, head } = await locked(tenant, id);
        if (!saved || saved.state !== 'attempting' || saved.attempt_token !== token) return false;
        if (!saved.payload.clear && Number(head.blocked_until) < at) await connection.query('UPDATE ' + heads +
          ' SET blocked_until=$4 WHERE tenant_id=$1 AND consumer=$2 AND dedup_key=$3 AND request_id=$5',
        [tenant, saved.consumer, saved.dedup_key, at + c.SHORT, id]);
        await connection.query('UPDATE ' + requests +
          ' SET attempt_until=$3 WHERE tenant_id=$1 AND request_id=$2 AND attempt_token=$4', [tenant, id, until, token]);
        return true;
      });
    },
    async finish ({ tenant, id, token, state, at, nextAt, receipt, cleared }) {
      if (!['accepted', 'uncertain', 'cancelled'].includes(state)) throw new TypeError('Notification completion state required');
      c.instant(at); c.instant(at + c.SUCCESS); c.instant(nextAt);
      if (Buffer.byteLength(JSON.stringify(receipt ?? null)) > maxBytes || !Array.isArray(cleared) || cleared.length > maxRows || cleared.some(id => !c.UUID.test(id))) throw new Error('NOTIFICATION_RECEIPT_BOUND');
      return tx(tenant, async () => {
        const { saved, head } = await locked(tenant, id);
        if (!saved || saved.state !== 'attempting' || saved.attempt_token !== token) return false;
        if (state === 'uncertain' && !saved.payload.clear) nextAt = Math.max(nextAt, Number(head.blocked_until) + 1);
        await connection.query('UPDATE ' + requests +
          ' SET state=$4,next_at=$5,accepted_at=$6,receipt=$7::jsonb WHERE tenant_id=$1 AND request_id=$2 AND attempt_token=$3',
        [tenant, id, token, state, nextAt, state === 'accepted' ? at : null, JSON.stringify(receipt ?? null)]);
        if (state === 'accepted') {
          await connection.query('UPDATE ' + heads + ' SET blocked_until=$4 WHERE tenant_id=$1 AND consumer=$2 AND dedup_key=$3 AND request_id=$5',
            [tenant, saved.consumer, saved.dedup_key, at + (saved.payload.clear ? 0 : c.SUCCESS), id]);
          // Only an explicitly acknowledged cancellation effect releases its persisted receipt.
          if (saved.payload.clear && cleared.length) await connection.query('UPDATE ' + requests +
            ' SET cleared_at=$4 WHERE tenant_id=$1 AND consumer=$2 AND request_id=ANY($3::uuid[]) AND state=\'accepted\'',
          [tenant, saved.consumer, cleared, at]);
        }
        return true;
      });
    },
    async receipts ({ tenant, consumer, at }) {
      c.instant(at);
      return tx(tenant, async () => bounded((await connection.query('SELECT request_id,receipt FROM ' + requests +
        ' WHERE tenant_id=$1 AND consumer=$2 AND state=\'accepted\' AND receipt IS NOT NULL AND receipt <> \'null\'::jsonb AND cleared_at IS NULL AND accepted_at >= $3 ORDER BY created_at,request_id LIMIT $4',
      [tenant, consumer, Math.max(0, at - c.RECEIPT), maxRows + 1])).rows));
    }
  });
};
