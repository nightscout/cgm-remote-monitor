'use strict';

// The agreement rule, pure: a member may work its slice only while its own row
// is live, every live row of its pool kind agrees on the member count and the
// slice rule, and no two live rows share an ordinal. Any conflict stops every
// member of that kind (each one reads the same rows), never a member of another
// kind: callers pass only their own kind's rows.
function assess (self, rows) {
  const live = rows.filter(row => row.live);
  const conflicts = [];
  if (!live.some(row => row.memberId === self.memberId && row.ordinal === self.ordinal)) conflicts.push({ reason: 'POOL_SELF_NOT_LIVE' });
  const counts = [...new Set(live.map(row => row.expectedMembers))].sort((a, b) => a - b);
  if (counts.some(count => count !== self.members)) conflicts.push({ reason: 'POOL_COUNT_DISAGREEMENT', counts });
  const rules = [...new Set(live.map(row => row.rule))].sort();
  if (rules.some(rule => rule !== self.rule)) conflicts.push({ reason: 'POOL_RULE_DISAGREEMENT', rules });
  const seen = new Map();
  for (const row of live) seen.set(row.ordinal, (seen.get(row.ordinal) || 0) + 1);
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([ordinal]) => ordinal).sort((a, b) => a - b);
  if (duplicated.length) conflicts.push({ reason: 'POOL_DUPLICATE_ORDINAL', ordinals: duplicated });
  const liveOrdinals = [...seen.keys()].sort((a, b) => a - b);
  const missingOrdinals = [];
  for (let ordinal = 0; ordinal < self.members; ordinal++) if (!seen.has(ordinal)) missingOrdinals.push(ordinal);
  return Object.freeze({ eligible: conflicts.length === 0, reason: conflicts.length ? conflicts[0].reason : null,
    conflicts: Object.freeze(conflicts), liveOrdinals, missingOrdinals });
}

module.exports = { assess };
