'use strict';

const shiro = require('shiro-trie');

function compile (values, nonempty = false) {
  if (!Array.isArray(values) || values.length > 256 || (nonempty && !values.length) ||
      new Set(values).size !== values.length || values.some(value => typeof value !== 'string' ||
        !value.length || value.length > 512 || /[\x00-\x20\x7f]/.test(value))) {
    throw new TypeError('Permissions require distinct bounded Shiro strings');
  }
  const trie = shiro.new();
  trie.add(values);
  return trie.get();
}

function permissionsValid (values, nonempty = false) {
  try { compile(values, nonempty); return true; } catch { return false; }
}

// Language containment, using the actual installed Shiro compiler. A permission
// prefix is an unbounded suffix grant; wildcard edges and exact edges can both
// satisfy one requested segment. Checking a wildcard string is not containment.
// Explore pairs of determinized trie states over their finite literal alphabet
// plus one representative for every other possible segment. This covers unknown
// extensions and arbitrary depth, rather than enumerating today's API operations.
function permissionsContained (proposed, ceiling) {
  const trees = [compile(proposed), compile(ceiling)];
  const nodes = [], ids = new WeakMap(), alphabet = new Set(['*']);
  function visit (node) {
    if (ids.has(node)) return ids.get(node);
    const id = nodes.length; ids.set(node, id); nodes.push(node);
    for (const key of Object.keys(node)) { alphabet.add(key); visit(node[key]); }
    return id;
  }
  const roots = trees.map(visit);
  // null is outside the literal alphabet; it cannot collide with an extension.
  const symbols = [...alphabet, null];
  const universal = -1;
  function step (state, symbol) {
    const result = new Set();
    for (const id of state) {
      if (id === universal) { result.add(universal); continue; }
      const node = nodes[id];
      if (Object.hasOwn(node, '*') && Object.keys(node['*']).length === 0) {
        result.add(universal); continue;
      }
      if (Object.hasOwn(node, '*')) result.add(ids.get(node['*']));
      if (symbol !== null && symbol !== '*' && Object.hasOwn(node, symbol)) result.add(ids.get(node[symbol]));
    }
    if (result.has(universal)) return [universal];
    return [...result].sort((a, b) => a - b);
  }
  function accepts (state, lastStar) {
    // Shiro check appends an implicit '*' unless the request ends in '*',
    // then accepts any surviving path. Preserve even its shorter-prefix cases.
    return (lastStar ? state : step(state, '*')).length > 0;
  }
  const pending = [[[roots[0]], [roots[1]]]], seen = new Set();
  while (pending.length) {
    const [left, right] = pending.pop();
    for (const symbol of symbols) {
      const nextLeft = step(left, symbol);
      if (!nextLeft.length) continue;
      const nextRight = step(right, symbol);
      if (accepts(nextLeft, symbol === '*') && !accepts(nextRight, symbol === '*')) return false;
      const key = nextLeft.join(',') + '/' + nextRight.join(',');
      if (!seen.has(key)) {
        seen.add(key);
        if (seen.size > 100000) throw new TypeError('Permission implication exceeds supported complexity');
        pending.push([nextLeft, nextRight]);
      }
    }
  }
  return true;
}

module.exports = { permissionsValid, permissionsContained };
