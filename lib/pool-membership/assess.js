'use strict';

// The agreement rule, pure. The member count of a pool kind has one home: the
// operator-set desired row (pool_desired: members, previous_members, rule,
// revision). A pod carries only its ordinal.
//
// Effective count: the desired count once every ordinal below it is live.
// Until then, and only while no live member has yet applied the desired count
// (each row records the count its member works, `appliedMembers`), the
// previous count if every ordinal below that is live: a scale change switches
// slices only when the new set of members is complete, and every member reads
// the same rows, so all switch together, within one cycle. Otherwise the
// desired count with its missing ordinals reported. A missing member's tenants
// are then unworked: takeover of a stale slice is undecided, and a completed
// switch never falls back to the previous count when a member is lost.
//
// A member may work its slice only while its own row is live, the desired row
// exists, every live row and the desired row name this build's slice rule, and
// no two live rows share an ordinal. Any conflict stops every member of that
// kind (each reads the same rows), never a member of another kind: callers
// pass only their own kind's rows. A member whose ordinal is at or beyond the
// effective count is eligible with an empty slice.
function covered (ordinals, count) {
  for (let ordinal = 0; ordinal < count; ordinal++) if (!ordinals.has(ordinal)) return false;
  return true;
}

function effective (live, desired) {
  if (!desired) return { members: null, switching: false };
  const ordinals = new Set(live.map(row => row.ordinal));
  if (covered(ordinals, desired.members)) return { members: desired.members, switching: false };
  if (desired.previousMembers && covered(ordinals, desired.previousMembers) &&
      !live.some(row => row.appliedMembers === desired.members)) return { members: desired.previousMembers, switching: true };
  return { members: desired.members, switching: false };
}

function assess (self, rows, desired) {
  const live = rows.filter(row => row.live);
  const conflicts = [];
  if (!live.some(row => row.memberId === self.memberId && row.ordinal === self.ordinal)) conflicts.push({ reason: 'POOL_SELF_NOT_LIVE' });
  if (!desired) conflicts.push({ reason: 'POOL_COUNT_UNSET' });
  const rules = [...new Set([...live.map(row => row.rule), ...(desired ? [desired.rule] : [])])].sort();
  if (rules.some(rule => rule !== self.rule)) conflicts.push({ reason: 'POOL_RULE_DISAGREEMENT', rules });
  const seen = new Map();
  for (const row of live) seen.set(row.ordinal, (seen.get(row.ordinal) || 0) + 1);
  const duplicated = [...seen].filter(([, n]) => n > 1).map(([ordinal]) => ordinal).sort((a, b) => a - b);
  if (duplicated.length) conflicts.push({ reason: 'POOL_DUPLICATE_ORDINAL', ordinals: duplicated });
  const liveOrdinals = [...seen.keys()].sort((a, b) => a - b);
  const { members, switching } = effective(live, desired);
  const missingOrdinals = [];
  for (let ordinal = 0; ordinal < (members || 0); ordinal++) if (!seen.has(ordinal)) missingOrdinals.push(ordinal);
  return Object.freeze({ eligible: conflicts.length === 0, reason: conflicts.length ? conflicts[0].reason : null,
    conflicts: Object.freeze(conflicts), liveOrdinals, missingOrdinals, members,
    desiredMembers: desired ? desired.members : null, previousMembers: desired ? desired.previousMembers || null : null,
    revision: desired ? desired.revision : null, switching, outside: members !== null && self.ordinal >= members });
}

module.exports = { assess, effective };
