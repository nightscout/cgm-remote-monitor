'use strict';

// Operator-assisted tenant ownership: list, add a co-owner, transfer, recover.
// Private operator plane only. The operator identity comes from trusted
// composition; the target tenant comes from the request and must be confirmed
// by current operator authority inside the store transaction.
const { permissionsValid } = require('../subject-admin/permission-implication');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATIONS = Object.freeze(['list', 'add', 'transfer', 'recover']);
const MAX_OWNERS = 64;

function failure (code) {
  return Object.assign(new Error(code), { code });
}

function plain (value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function exact (value, required, optional = []) {
  return plain(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function operatorIdentity (context) {
  if (!exact(context, ['principal', 'consumer']) || !NAME.test(context.principal) || !NAME.test(context.consumer)) {
    throw new TypeError('Ownership operations require a trusted operator principal and consumer');
  }
  return { principal: context.principal, consumer: context.consumer };
}

function actorRef (value) {
  if (!exact(value, ['principal', 'consumer']) || typeof value.principal !== 'string' || typeof value.consumer !== 'string' ||
      !NAME.test(value.principal) || !NAME.test(value.consumer)) throw failure('OWNERSHIP_INVALID');
  return { principal: value.principal, consumer: value.consumer };
}

function ownerSet (value) {
  if (!Array.isArray(value) || value.length > MAX_OWNERS) throw failure('OWNERSHIP_INVALID');
  const owners = value.map(actorRef);
  const keys = owners.map(key);
  if (new Set(keys).size !== keys.length) throw failure('OWNERSHIP_INVALID');
  return sort(owners);
}

function key (owner) { return owner.principal + '\u0000' + owner.consumer; }
function sort (owners) { return owners.slice().sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0); }

function tenantOf (input) {
  if (typeof input.tenant !== 'string' || !UUID.test(input.tenant)) throw failure('OWNERSHIP_INVALID');
  return input.tenant;
}

function delegation (value) {
  if (!permissionsValid(value)) throw failure('OWNERSHIP_INVALID');
  return value.slice();
}

// Validate and normalise each operation's input. Only identifiers and
// permission strings are accepted: there is no credential field to carry.
function proposalFor (operation, input) {
  if (operation === 'list') {
    if (!exact(input, ['tenant'])) throw failure('OWNERSHIP_INVALID');
    return { tenant: tenantOf(input) };
  }
  if (operation === 'add' || operation === 'recover') {
    if (!exact(input, ['tenant', 'owner', 'delegable', 'expectedOwners'])) throw failure('OWNERSHIP_INVALID');
    return { tenant: tenantOf(input), owner: actorRef(input.owner), delegable: delegation(input.delegable),
      expectedOwners: ownerSet(input.expectedOwners) };
  }
  if (operation === 'transfer') {
    if (!exact(input, ['tenant', 'from', 'to', 'expectedOwners'])) throw failure('OWNERSHIP_INVALID');
    const proposal = { tenant: tenantOf(input), from: actorRef(input.from), to: actorRef(input.to),
      expectedOwners: ownerSet(input.expectedOwners) };
    if (key(proposal.from) === key(proposal.to)) throw failure('OWNERSHIP_INVALID');
    return proposal;
  }
  throw failure('OWNERSHIP_INVALID');
}

// Current operator authority must name exactly this tenant, plane and actor.
// An authority bound to another tenant (or a stale grant) has no effect.
function checkAuthority (result, actor) {
  if (!exact(result, ['allowed', 'current', 'tenant', 'plane', 'principal', 'consumer']) ||
      result.allowed !== true || result.current !== true || result.plane !== 'operator' ||
      result.tenant !== actor.tenant || result.principal !== actor.principal || result.consumer !== actor.consumer) {
    throw failure('OWNERSHIP_FORBIDDEN');
  }
}

function createOwnershipOperations ({ store, authorizeOperator }) {
  if (!store || typeof store.list !== 'function' || typeof store.change !== 'function' || typeof authorizeOperator !== 'function') {
    throw new TypeError('Ownership operations require persistence and operator authorization');
  }
  async function run (operation, context, input) {
    const operator = operatorIdentity(context);
    const proposal = proposalFor(operation, input);
    const actor = { tenant: proposal.tenant, ...operator };
    const authorize = async connection => checkAuthority(await authorizeOperator({ connection, operation, ...actor }), actor);
    return operation === 'list' ? store.list(actor, authorize) : store.change(actor, operation, proposal, authorize);
  }
  return Object.freeze({
    list: (context, input) => run('list', context, input),
    add: (context, input) => run('add', context, input),
    transfer: (context, input) => run('transfer', context, input),
    recover: (context, input) => run('recover', context, input)
  });
}

// Plan one change against the locked current state. Returns either a refusal
// code or the exact writes; every plan preserves at least one owner.
function plan (operation, proposal, state) {
  const owners = sort(state.owners);
  if (JSON.stringify(owners) !== JSON.stringify(proposal.expectedOwners)) return { code: 'OWNERSHIP_CONFLICT' };
  const isOwner = ref => owners.some(owner => key(owner) === key(ref));
  if (operation === 'add') {
    if (!state.subjects.has(proposal.owner.principal)) return { code: 'OWNERSHIP_SUBJECT_UNKNOWN' };
    if (isOwner(proposal.owner)) return { code: 'OWNERSHIP_ALREADY_OWNER' };
    if (!state.contained(proposal.delegable)) return { code: 'OWNERSHIP_DELEGATION_EXCEEDS_CEILING' };
    return { deactivate: [], activate: { ...proposal.owner, delegable: proposal.delegable }, target: proposal.owner };
  }
  if (operation === 'transfer') {
    if (!isOwner(proposal.from)) return { code: 'OWNERSHIP_NOT_OWNER' };
    if (!state.subjects.has(proposal.to.principal)) return { code: 'OWNERSHIP_SUBJECT_UNKNOWN' };
    if (isOwner(proposal.to)) return { code: 'OWNERSHIP_ALREADY_OWNER' };
    const from = state.actors.find(row => key(row) === key(proposal.from));
    return { deactivate: [proposal.from], activate: { ...proposal.to, delegable: from.delegable.slice() }, target: proposal.to };
  }
  if (operation === 'recover') {
    if (!state.subjects.has(proposal.owner.principal)) return { code: 'OWNERSHIP_SUBJECT_UNKNOWN' };
    if (!state.contained(proposal.delegable)) return { code: 'OWNERSHIP_DELEGATION_EXCEEDS_CEILING' };
    // Recovery leaves exactly the named owner active; every other active actor row is retired.
    const deactivate = state.actors.filter(row => row.active && key(row) !== key(proposal.owner))
      .map(row => ({ principal: row.principal, consumer: row.consumer }));
    const already = isOwner(proposal.owner);
    if (already && !deactivate.length) return { code: 'OWNERSHIP_UNCHANGED' };
    return { deactivate, activate: already ? null : { ...proposal.owner, delegable: proposal.delegable }, target: proposal.owner };
  }
  return { code: 'OWNERSHIP_INVALID' };
}

module.exports = { createOwnershipOperations, plan, sort, key, OPERATIONS, checkAuthority };
