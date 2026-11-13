'use strict';

const { randomUUID } = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
const scope = require('../storage/tenant-scope');
const c = require('./contract');
const assertReady = require('./readiness');
const producer = require('./producer-state');

module.exports = function notificationStore ({ connection, namespace, maxRows, maxBytes } = {}) {
  if (!connection || typeof connection.transaction !== 'function' || typeof connection.query !== 'function' ||
      typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace === 'public' ||
      namespace.startsWith('pg_') || namespace === 'information_schema') throw new TypeError('Explicit notification transaction/schema required');
  c.integer(maxRows, 'maxRows'); c.integer(maxBytes, 'maxBytes');
  const requests = '"' + namespace + '".tenant_notification_requests', heads = '"' + namespace + '".tenant_notification_heads';
  const states = '"' + namespace + '".tenant_notification_state';
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
    await producer.lock(connection, tenant, observed.consumer);
    await connection.query('SELECT * FROM ' + states + ' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE', [tenant, observed.consumer]);
    const head = (await connection.query('SELECT * FROM ' + heads + ' WHERE tenant_id=$1 AND consumer=$2 AND dedup_key=$3 FOR UPDATE',
      [tenant, observed.consumer, observed.dedup_key])).rows[0];
    if (!head) throw new Error('NOTIFICATION_HEAD_MISSING');
    const saved = await one(tenant, id, true);
    return head.request_id === id ? { head, saved } : {};
  }
  async function enqueueIn ({ tenant, consumer, key, origin, configIdentity, payload, at, normalPolicy }) {
      c.policy(normalPolicy);
      if (!key?.startsWith(normalPolicy + ':')) throw new Error('NOTIFICATION_POLICY_MISMATCH');
      c.instant(at); c.instant(at + c.SHORT); if (typeof consumer !== 'string' || !c.NAME.test(consumer)) throw new TypeError('Explicit notification consumer required');
      c.text(key, 'dedup key'); c.text(origin, 'origin'); c.text(configIdentity, 'config identity');
      if (Buffer.byteLength(JSON.stringify(payload)) > maxBytes) throw new Error('NOTIFICATION_PAYLOAD_BOUND');
      await producer.lock(connection, tenant, consumer);
      await connection.query('SELECT * FROM ' + states + ' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE', [tenant, consumer]);
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
          if (normalPolicy === 'pushnotify' && !saved.payload.clear && Number(head.blocked_until) >= at) return saved;
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
          [tenant, consumer, key, id, at + (normalPolicy === 'pushnotify' && !payload.clear ? c.SHORT : 0)]);
        return inserted.rows[0];
  }

  return Object.freeze({
    ready (tenant) { return tx(tenant, async () => true); },
    enqueue (input) { return tx(input.tenant, () => enqueueIn(input)); },
    async consume ({tenant, consumer, transform}) {
      if (typeof transform !== 'function') throw new TypeError('Explicit producer transform required');
      return tx(tenant, async () => {
        await producer.lock(connection, tenant, consumer);
        const previous = (await connection.query('SELECT * FROM ' + states + ' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE', [tenant, consumer])).rows[0];
        if (previous && (!Number.isSafeInteger(Number(previous.revision)) || Number(previous.revision) < 1)) throw new Error('NOTIFICATION_PRODUCER_REVISION');
        const revision = previous ? Number(previous.revision) + 1 : 1;
        c.integer(revision, 'producer revision');
        const next = await transform(previous ? structuredClone(previous) : null, revision);
        if (!next || typeof next.configIdentity !== 'string' || !Array.isArray(next.intents) || next.intents.length > maxRows ||
            Buffer.byteLength(JSON.stringify(next.producer)) > maxBytes) throw new Error('NOTIFICATION_PRODUCER_BOUND');
        const changed = !previous || previous.config_identity !== next.configIdentity || !isDeepStrictEqual(previous.producer, next.producer);
        if (changed) {
          if (previous) {
            const updated = await connection.query('UPDATE ' + states + ' SET revision=$3,config_identity=$4,producer=$5::jsonb WHERE tenant_id=$1 AND consumer=$2 AND revision=$6 RETURNING *',
              [tenant, consumer, revision, next.configIdentity, JSON.stringify(next.producer), previous.revision]);
            if (updated.rows.length !== 1) throw new Error('NOTIFICATION_PRODUCER_CAS');
          } else await connection.query('INSERT INTO ' + states + ' (tenant_id,consumer,revision,config_identity,producer) VALUES ($1,$2,$3,$4,$5::jsonb)',
            [tenant, consumer, revision, next.configIdentity, JSON.stringify(next.producer)]);
        }
        // Reconcile bounded active requests even when their retry deadline has
        // not arrived. Normal same-payload retry identity survives a fresh RT
        // output/restart; clears require exact current private cause origin.
        const active = bounded((await connection.query('SELECT * FROM ' + requests +
          ' /* notification-producer-active */ WHERE tenant_id=$1 AND consumer=$2 AND state IN (\'pending\',\'uncertain\',\'attempting\') ORDER BY created_at,request_id LIMIT $3', [tenant, consumer, maxRows + 1])).rows);
        for (const pending of next.retireObsolete === true ? active : []) {
          const current = next.intents.some(intent => intent.configIdentity === pending.config_identity &&
            c.sameEffect(intent.payload, pending.payload) && (!pending.payload.clear || intent.origin === pending.origin));
          if (!current) {
            const lockedRow = await locked(tenant, pending.request_id);
            if (lockedRow.saved) await connection.query('UPDATE ' + requests + ' SET state=\'cancelled\' WHERE tenant_id=$1 AND request_id=$2', [tenant, pending.request_id]);
          }
        }
        const rows = [];
        for (const intent of next.intents) rows.push(await enqueueIn({...intent, tenant, consumer}));
        return {producer: next.producer, configIdentity: next.configIdentity, revision: changed ? revision : Number(previous.revision), rows};
      }); // Producer state and all request intents COMMIT before any adapter call.
    },
    async due ({ tenant, consumer, at, normalPolicy }) {
      c.instant(at); c.policy(normalPolicy);
      return tx(tenant, async () => bounded((await connection.query('SELECT * FROM ' + requests +
        ' WHERE tenant_id=$1 AND consumer=$2 AND dedup_key LIKE $3 AND ((state IN (\'pending\',\'uncertain\') AND next_at <= $4) OR (state=\'attempting\' AND attempt_until <= $4)) ORDER BY created_at,request_id LIMIT $5',
      [tenant, consumer, normalPolicy + ':%', at, maxRows + 1])).rows));
    },
    async begin ({ tenant, id, at, until, normalPolicy }) {
      c.policy(normalPolicy); c.instant(at); c.instant(until); if (until <= at) throw new TypeError('Notification attempt deadline must advance');
      return tx(tenant, async () => {
        const { saved, head } = await locked(tenant, id);
        if (saved && !saved.dedup_key.startsWith(normalPolicy + ':')) throw new Error('NOTIFICATION_POLICY_MISMATCH');
        if (!saved || ['accepted', 'cancelled'].includes(saved.state) || Number(saved.next_at) > at ||
            (normalPolicy === 'pushnotify' && saved.attempt > 0 && !saved.payload.clear && Number(head.blocked_until) >= at) ||
            (saved.state === 'attempting' && Number(saved.attempt_until) > at)) return null;
        const token = randomUUID();
        return (await connection.query('UPDATE ' + requests +
          ' SET state=\'attempting\',attempt=attempt+1,attempt_token=$3,attempt_until=$4 WHERE tenant_id=$1 AND request_id=$2 RETURNING *',
        [tenant, id, token, until])).rows[0];
      });
    },
    async dispatch ({ tenant, id, token, at, until, normalPolicy }) {
      c.policy(normalPolicy); c.instant(at); c.instant(at + c.SHORT); c.instant(until);
      if (until <= at) throw new TypeError('Notification dispatch deadline must advance');
      return tx(tenant, async () => {
        const { saved, head } = await locked(tenant, id);
        if (!saved || saved.state !== 'attempting' || saved.attempt_token !== token) return false;
        if (!saved.dedup_key.startsWith(normalPolicy + ':')) throw new Error('NOTIFICATION_POLICY_MISMATCH');
        if (normalPolicy === 'pushnotify' && !saved.payload.clear && Number(head.blocked_until) < at) await connection.query('UPDATE ' + heads +
          ' SET blocked_until=$4 WHERE tenant_id=$1 AND consumer=$2 AND dedup_key=$3 AND request_id=$5',
        [tenant, saved.consumer, saved.dedup_key, at + c.SHORT, id]);
        await connection.query('UPDATE ' + requests +
          ' SET attempt_until=$3 WHERE tenant_id=$1 AND request_id=$2 AND attempt_token=$4', [tenant, id, until, token]);
        return true;
      });
    },
    async finish ({ tenant, id, token, state, at, nextAt, receipt, cleared, normalPolicy }) {
      c.policy(normalPolicy);
      if (!['accepted', 'uncertain', 'cancelled'].includes(state)) throw new TypeError('Notification completion state required');
      c.instant(at); c.instant(at + c.SUCCESS); c.instant(nextAt);
      if (Buffer.byteLength(JSON.stringify(receipt ?? null)) > maxBytes || !Array.isArray(cleared) || cleared.length > maxRows || cleared.some(id => !c.UUID.test(id))) throw new Error('NOTIFICATION_RECEIPT_BOUND');
      return tx(tenant, async () => {
        const { saved, head } = await locked(tenant, id);
        if (!saved || saved.state !== 'attempting' || saved.attempt_token !== token) return false;
        if (!saved.dedup_key.startsWith(normalPolicy + ':')) throw new Error('NOTIFICATION_POLICY_MISMATCH');
        if (state === 'uncertain' && normalPolicy === 'pushnotify' && !saved.payload.clear) nextAt = Math.max(nextAt, Number(head.blocked_until) + 1);
        await connection.query('UPDATE ' + requests +
          ' SET state=$4,next_at=$5,accepted_at=$6,receipt=$7::jsonb WHERE tenant_id=$1 AND request_id=$2 AND attempt_token=$3',
        [tenant, id, token, state, nextAt, state === 'accepted' ? at : null, JSON.stringify(receipt ?? null)]);
        if (state === 'accepted') {
          await connection.query('UPDATE ' + heads + ' SET blocked_until=$4 WHERE tenant_id=$1 AND consumer=$2 AND dedup_key=$3 AND request_id=$5',
            [tenant, saved.consumer, saved.dedup_key, at + (normalPolicy === 'pushnotify' && !saved.payload.clear ? c.SUCCESS : 0), id]);
          // Only an explicitly acknowledged cancellation effect releases its persisted receipt.
          if (saved.payload.clear && cleared.length) await connection.query('UPDATE ' + requests +
            ' SET cleared_at=$4 WHERE tenant_id=$1 AND consumer=$2 AND request_id=ANY($3::uuid[]) AND state=\'accepted\' AND dedup_key LIKE $5',
          [tenant, saved.consumer, cleared, at, normalPolicy + ':%']);
        }
        return true;
      });
    },
    async receipts ({ tenant, consumer, at, normalPolicy }) {
      c.instant(at);
      if (c.policy(normalPolicy) !== 'pushnotify') throw new Error('NOTIFICATION_RECEIPTS_NOT_APPLICABLE');
      return tx(tenant, async () => bounded((await connection.query('SELECT request_id,receipt FROM ' + requests +
        ' WHERE tenant_id=$1 AND consumer=$2 AND dedup_key LIKE $3 AND state=\'accepted\' AND receipt IS NOT NULL AND receipt <> \'null\'::jsonb AND cleared_at IS NULL AND accepted_at >= $4 ORDER BY created_at,request_id LIMIT $5',
      [tenant, consumer, normalPolicy + ':%', Math.max(0, at - c.RECEIPT), maxRows + 1])).rows));
    }
  });
};
