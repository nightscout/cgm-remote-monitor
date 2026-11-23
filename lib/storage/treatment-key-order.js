'use strict';

// The order in which single-tenant MongoDB finds the treatments a fallback
// key names (resend parity, 2026-11-23).
//
// A v1 treatments write without an identifier or _id is matched by its
// fallback key (lib/server/treatment-fallback-key.js): created_at and
// eventType by equality, plus the client identity or the amounts. MongoDB
// serves that filter with the treatments index
// { eventType: 1, created_at: -1, identifier: -1, date: -1 }
// (lib/server/treatments.js indexedFields), measured as the winning plan for
// the find, the findOne and the upserting replaceOne with and without 20k
// other rows (official/dev 79144cbd0, MongoDB 8.0.34). Among rows equal in
// eventType and created_at, an index scan returns them by identifier
// descending, then date descending, then RecordId (insertion order). So the
// unsorted replaceOne, its server-date read and its reply's findOne all take
// the row with the greatest identifier first (an API v3 record before one
// without an identifier), and only among rows equal in both does the
// earliest stored come first.
//
// BSON order, as far as treatments carry these fields: a missing or null
// value sorts lowest, then numbers, then strings (compared bytewise: COLLATE
// "C"), then objects, arrays, booleans. A descending scan reverses it. Not
// modelled (read-derived limit): order within objects and booleans, and an
// array value, which a multikey index places at each element.
//
// A trusted, fixed fragment for a table that carries insertion_ordinal; it
// never takes caller input.
function descending (field) {
  const value = `(doc -> '${field}')`;
  return [
    `CASE jsonb_typeof(${value}) WHEN 'number' THEN 2 WHEN 'string' THEN 3 WHEN 'object' THEN 4` +
      ` WHEN 'array' THEN 5 WHEN 'boolean' THEN 6 ELSE 1 END DESC`,
    `CASE WHEN jsonb_typeof(${value}) = 'number' THEN ${value}::numeric END DESC NULLS LAST`,
    `CASE WHEN jsonb_typeof(${value}) = 'string' THEN ${value} #>> '{}' END COLLATE "C" DESC NULLS LAST`
  ];
}

const ORDER_BY = Object.freeze([...descending('identifier'), ...descending('date'), 'insertion_ordinal ASC'].join(', '));

// The filter shape MongoDB serves with that index: created_at and eventType
// both pinned by equality, in the filter's top-level conjunction, or in every
// branch of a top-level $or (srv-dates findForReplace reads a batch's
// filters as one $or; within one branch's rows the order is the same).
function conjuncts (node, out = []) {
  if (node && node.op === 'and' && Array.isArray(node.nodes)) node.nodes.forEach(n => conjuncts(n, out));
  else if (node) out.push(node);
  return out;
}

function pinned (node) {
  const nodes = conjuncts(node);
  const eq = field => nodes.some(n => n.op === 'eq' && n.field === field && n.value !== null && typeof n.value !== 'object');
  return eq('created_at') && eq('eventType');
}

function applies (ast) {
  if (!ast) return false;
  if (ast.op === 'or') return Array.isArray(ast.nodes) && ast.nodes.length > 0 && ast.nodes.every(applies);
  return pinned(ast);
}

module.exports = { ORDER_BY, applies };
