'use strict';
// Only pgoutput protocol v1, no streaming, binary tuples, messages, truncate or
// clinical relations. Caller must retain a complete committed transaction.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = code => { throw Object.assign(new Error(code), { code }); };
const lsn = value => (value >> 32n).toString(16).toUpperCase() + '/' + (value & 0xffffffffn).toString(16).toUpperCase();
function decode (rows, { clockNamespace, activityNamespace, maxMessages = 10000, maxBytes = 1048576 }) {
  if (!Array.isArray(rows) || rows.length > maxMessages) refuse('FEED_BATCH_BOUNDS');
  const relations = new Map(), hints = new Map();
  let bytes = 0, transaction = false, committed = null;
  const add = (tenant, kind) => { if (!UUID.test(tenant || '')) refuse('FEED_TENANT_REFUSED'); const old = hints.get(tenant); hints.set(tenant, old && old !== kind ? 'both' : kind); };
  for (const row of rows) {
    const data = row.data;
    if (!Buffer.isBuffer(data) || (bytes += data.length) > maxBytes || !data.length) refuse('FEED_BATCH_BOUNDS');
    let offset = 0;
    const take = n => { if (offset + n > data.length) refuse('FEED_PROTOCOL_REFUSED'); const at = offset; offset += n; return at; };
    const u8 = () => data.readUInt8(take(1)), u16 = () => data.readUInt16BE(take(2)), u32 = () => data.readUInt32BE(take(4));
    const text = () => { const end = data.indexOf(0,offset); if (end < offset) refuse('FEED_PROTOCOL_REFUSED'); const value = data.toString('utf8',offset,end); offset = end + 1; return value; };
    const tuple = relation => {
      const count = u16(); if (count !== relation.columns.length) refuse('FEED_PROTOCOL_REFUSED');
      const values = [];
      for (let i = 0; i < count; i++) { const kind = u8();
        if (kind === 110 || kind === 117) values.push(null);
        else if (kind === 116) { const size = u32(); if (size > 256) refuse('FEED_PROTOCOL_REFUSED'); values.push(data.toString('utf8',take(size),offset)); }
        else refuse('FEED_PROTOCOL_REFUSED'); }
      return values[relation.columns.indexOf('tenant_id')];
    };
    const type = u8();
    if (type === 66) { if (transaction) refuse('FEED_PROTOCOL_REFUSED'); transaction = true; take(20); }
    else if (type === 67) { if (!transaction) refuse('FEED_PROTOCOL_REFUSED'); if (u8() !== 0) refuse('FEED_PROTOCOL_REFUSED'); take(8); committed = lsn(data.readBigUInt64BE(take(8))); take(8); transaction = false; }
    else if (type === 82) {
      const id = u32(), namespace = text(), table = text(); u8(); const count = u16(), columns = [], types = [], flags = [];
      const kind = namespace === clockNamespace && table === 'tenant_write_clock' ? 'data'
        : namespace === activityNamespace && table === 'tenant_activity' ? 'activity' : null;
      if (!kind) refuse('FEED_FOREIGN_RELATION');
      for (let i = 0; i < count; i++) { flags.push(u8()); columns.push(text()); types.push(u32()); u32(); }
      const expected = kind === 'data' ? ['tenant_id','last_stamp','last_delete_stamp']
        : ['tenant_id','version','paused','suspended','deletion_request_id','paused_before_deletion'];
      const expectedTypes = kind === 'data' ? [2950,20,20] : [2950,20,16,16,2950,16];
      if (JSON.stringify(types) !== JSON.stringify(expectedTypes) || flags.some((flag,i) => flag !== (i===0 ? 1 : 0))) refuse('FEED_RELATION_SHAPE');
      if (JSON.stringify(columns) !== JSON.stringify(expected)) refuse('FEED_RELATION_SHAPE');
      relations.set(id,{ kind,columns });
    } else if ([73,85,68].includes(type)) {
      if (!transaction) refuse('FEED_PROTOCOL_REFUSED');
      const relation = relations.get(u32()); if (!relation) refuse('FEED_FOREIGN_RELATION');
      let tupleKind = u8(), tenant;
      if (type === 85 && [75,79].includes(tupleKind)) { add(tuple(relation),relation.kind); tupleKind = u8(); }
      if (type === 68 ? ![75,79].includes(tupleKind) : tupleKind !== 78) refuse('FEED_PROTOCOL_REFUSED');
      tenant = tuple(relation); add(tenant,relation.kind);
    } else refuse('FEED_PROTOCOL_REFUSED');
    if (offset !== data.length) refuse('FEED_PROTOCOL_REFUSED');
  }
  if (transaction || rows.length && !committed) refuse('FEED_INCOMPLETE_TRANSACTION');
  return Object.freeze({ hints, upto: committed, bytes, messages: rows.length });
}
module.exports = { decode };
