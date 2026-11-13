'use strict';

// Deliberately bounded grammar for this lifecycle catalogue, not SQL equivalence.
// Parse precedence/grouping; never rewrite bytes inside literals or identifiers.
const fail = () => { throw Object.assign(new Error('LIFECYCLE_WINDOW_SCHEMA_UNSAFE'), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' }); };
const FUNCTIONS = new Set(['nullif','current_setting','pg_backend_pid','tenant_lifecycle_backend_birth','clock_timestamp','now']);
const TYPES = new Set(['text','uuid','regrole','oid']);
const TABLES = new Set(['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations','tenant_lifecycle_restore_authority','tenant_lifecycle_restore_audit','tenant_lifecycle_restore_resume','tenant_lifecycle_operation_clearance']);
function structure (source, namespace) {
  // SQL NULL denotes an absent default/USING/CHECK. Empty/invalid text is unsafe.
  if (source === null) return ['absent'];
  if (typeof source !== 'string' || !source.length || source.length > 32768) fail();
  const tokens = []; let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset); let match;
    if ((match = /^\s+/.exec(rest))) { offset += match[0].length; continue; }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0]; let value = '', at = 1, ended = false;
      while (at < rest.length) {
        if (rest[at] === quote) {
          if (rest[at + 1] === quote) { value += quote; at += 2; continue; }
          at++; ended = true; break;
        }
        if (rest[at] === '\\' || rest.charCodeAt(at) === 0) fail();
        value += rest[at++];
      }
      if (!ended) fail();
      tokens.push({ kind: quote === "'" ? 'string' : 'id', value, quoted:quote === '"' }); offset += at;
    } else if ((match = /^[a-z_][a-z_0-9]*/i.exec(rest))) {
      tokens.push({ kind: 'id', value: match[0].toLowerCase() }); offset += match[0].length;
    } else if ((match = /^[0-9]+/.exec(rest))) {
      tokens.push({ kind: 'number', value: match[0] }); offset += match[0].length;
    } else if ((match = /^(::|<>|>=|[=~>.,()[\]])/.exec(rest))) {
      tokens.push({ kind: 'punct', value: match[0] }); offset += match[0].length;
    } else fail();
    if (tokens.length > 4096) fail();
  }
  if (!tokens.length) fail();
  let at = 0, depth = 0;
  const peek = value => tokens[at]?.value === value && ['id','punct'].includes(tokens[at].kind) && !tokens[at].quoted;
  const take = value => { if (peek(value)) { at++; return true; } return false; };
  const need = value => { if (!take(value)) fail(); };
  function identifier () {
    const token = tokens[at++]; if (token?.kind !== 'id' || !token.value) fail(); return token.value;
  }
  function name () {
    const parts = [identifier()]; while (take('.')) parts.push(identifier());
    return parts;
  }
  function qualified (parts, context) {
    if (parts.length === 2 && parts[0] === 'pg_catalog' &&
        (context === 'function' && FUNCTIONS.has(parts[1]) && parts[1] !== 'tenant_lifecycle_backend_birth' ||
         context === 'type' && TYPES.has(parts[1]) || context === 'relation' && parts[1] === 'pg_stat_activity')) return parts.slice(1);
    if (parts[0] === namespace &&
        (parts.length === 2 && (context === 'function' && parts[1] === 'tenant_lifecycle_backend_birth' || context === 'relation' && TABLES.has(parts[1])) ||
         context === 'field' && parts.length === 3 && TABLES.has(parts[1]))) return parts.slice(1);
    return parts;
  }
  function list (end, read) {
    const values = []; if (!peek(end)) { do { values.push(read()); } while (take(',')); }
    need(end); return values;
  }
  function query () {
    need('select'); const projection = expression(0); need('from'); const table = qualified(name(),'relation');
    const alias = peek('where') ? null : identifier(); need('where'); const where = expression(0);
    if (!(projection[0] === 'number' && projection[1] === '1') && !(projection[0] === 'name' && projection[1].length === 1 && projection[1][0] === 'backend_start')) fail();
    return ['select',projection,table,alias,where];
  }
  function atom () {
    if (take('(')) { const value = expression(0); need(')'); return value; }
    if (take('not')) return ['not',expression(30)];
    if (take('exists')) { need('('); const value = query(); need(')'); return ['exists',value]; }
    if (take('array')) { need('['); return ['array',list(']',()=>expression(0))]; }
    const token = tokens[at];
    if (token?.kind === 'string' || token?.kind === 'number') { at++; return [token.kind,token.value]; }
    if (['true','false','null','current_user'].some(value => peek(value))) { at++; return ['keyword',token.value]; }
    let parts = name();
    if (take('(')) {
      parts = qualified(parts,'function');
      if (parts.length !== 1 || !FUNCTIONS.has(parts[0]) && parts[0] !== 'any') fail();
      const args = list(')',()=>expression(0));
      const expected = { nullif:2, current_setting:2, any:1 }[parts[0]] || 0;
      if (args.length !== expected) fail();
      return ['call',parts[0],args];
    }
    return ['name',qualified(parts,'field')];
  }
  function expression (minimum) {
    if (++depth > 96) fail();
    let left = atom(), compared = false;
    while (at < tokens.length) {
      if (peek('::') && 60 >= minimum) {
        at++; const type = qualified(name(),'type'); if (type.length !== 1 || !TYPES.has(type[0])) fail();
        // PostgreSQL annotates string constants with ::text; their bytes remain.
        left = type[0] === 'text' && left[0] === 'string' ? left : ['cast',left,type[0]]; continue;
      }
      const op = tokens[at]?.quoted || !['id','punct'].includes(tokens[at]?.kind) ? undefined : tokens[at]?.value, priority = op === 'or' ? 10 : op === 'and' ? 20 : ['=','<>','>','>=','~','is'].includes(op) ? 40 : 0;
      if (!priority || priority < minimum) break;
      if (priority === 40 && compared) fail();
      compared = priority === 40;
      at++;
      if (op === 'is') { const negated = take('not'); need('null'); left = ['is-null',left,negated]; }
      else left = [op,left,expression(priority + 1)];
    }
    depth--; return left;
  }
  let result;
  if (take('check')) { need('('); result = ['check',expression(0)]; need(')'); }
  else if (take('primary')) { need('key'); need('('); result = ['primary',list(')',identifier)]; }
  else if (take('unique')) { need('('); result = ['unique',list(')',identifier)]; }
  else if (take('foreign')) {
    need('key'); need('('); const columns = list(')',identifier); need('references'); const table = qualified(name(),'relation'); need('(');
    result = ['foreign',columns,table,list(')',identifier)];
  } else if (peek('select')) result = query();
  else result = expression(0);
  if (at !== tokens.length) fail();
  return result;
}
module.exports = (source, namespace) => JSON.stringify(structure(source, namespace));
