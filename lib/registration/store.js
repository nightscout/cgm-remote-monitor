'use strict';

// Registration state in MongoDB (registration specification §5, §7).
//
// - `registrations` (env.registrations_collection): one document per product,
//   the stored registration as ./negotiate.js builds it. A unique index on
//   (vendor, product) decides which of two concurrent creates wins, and every
//   update is one replace conditional on the etag read before it, so a change
//   that raced another meets a stale etag.
// - `registration_namespaces` (env.registration_namespaces_collection): one
//   document per claimed extension namespace, keyed by the namespace, so the
//   first product to claim one holds it by MongoDB's unique `_id`, never by a
//   read before the write. `freed: true` once the owner frees it.
//
// Nothing here is a multi-document transaction; each invariant is one
// conditional write or one unique index.

const DUPLICATE_KEY = 11000;

function isDuplicate (err) {
  return Boolean(err) && (err.code === DUPLICATE_KEY || /E11000/.test(String(err.message)));
}

function strip (doc) {
  if (!doc) { return null; }
  const out = Object.assign({}, doc);
  delete out._id;
  return out;
}

function sameIdentity (a, b) {
  return Boolean(a && b) && a.vendor === b.vendor && a.product === b.product;
}

function holderName (holder) {
  return holder.vendor + '/' + holder.product;
}

function init (env, ctx) {
  const registrationsName = env.registrations_collection || 'registrations';
  const namespacesName = env.registration_namespaces_collection || 'registration_namespaces';

  function registrations () { return ctx.store.collection(registrationsName); }
  function namespaces () { return ctx.store.collection(namespacesName); }

  const store = {};

  // The unique index holds an invariant, so it is built here with
  // `unique: true` rather than through ctx.store.ensureIndexes, which treats
  // a failed build as a slowdown. The caller fails boot when this rejects.
  store.createIndexes = function createIndexes () {
    return registrations().createIndex(
      { 'identity.vendor': 1, 'identity.product': 1 },
      { unique: true, name: 'registration_identity_unique' }
    );
  };

  store.get = async function get (identity) {
    return strip(await registrations().findOne({
      'identity.vendor': identity.vendor, 'identity.product': identity.product
    }));
  };

  store.list = async function list () {
    const docs = await registrations().find({}).sort({ 'identity.vendor': 1, 'identity.product': 1 }).toArray();
    return docs.map(strip);
  };

  store.claims = async function claims (names) {
    if (!names.length) { return {}; }
    const docs = await namespaces().find({ _id: { $in: names } }).toArray();
    const out = {};
    docs.forEach(function (doc) { out[doc._id] = doc; });
    return out;
  };

  // The holder of a namespace other than `identity`, as "vendor/product", or
  // null: a namespace freed by its holder is held by nobody.
  store.claimedElsewhere = function claimedElsewhere (claims, identity, ns) {
    const claim = claims[ns];
    if (!claim || claim.freed || sameIdentity(claim.holder, identity)) { return null; }
    return holderName(claim.holder);
  };

  // Claims each namespace for `identity`: a new claim, or one its holder
  // freed, or one `identity` already holds. Resolves to the namespaces newly
  // inserted (to undo if the registration write then fails), or rejects with
  // `conflict` when another product claimed one first.
  store.claim = async function claim (identity, names) {
    const inserted = [];
    for (const ns of names) {
      try {
        await namespaces().insertOne({ _id: ns, holder: { vendor: identity.vendor, product: identity.product }, freed: false });
        inserted.push(ns);
      } catch (err) {
        if (!isDuplicate(err)) { throw err; }
        const taken = await namespaces().updateOne(
          { _id: ns, $or: [{ freed: true }, { 'holder.vendor': identity.vendor, 'holder.product': identity.product }] },
          { $set: { holder: { vendor: identity.vendor, product: identity.product }, freed: false } }
        );
        if (taken.matchedCount === 0) {
          await store.unclaim(identity, inserted);
          const conflict = new Error('namespace claimed concurrently: ' + ns);
          conflict.conflict = true;
          throw conflict;
        }
      }
    }
    return inserted;
  };

  store.unclaim = async function unclaim (identity, names) {
    if (!names.length) { return; }
    await namespaces().deleteMany({
      _id: { $in: names }, 'holder.vendor': identity.vendor, 'holder.product': identity.product
    });
  };

  // Marks the product's claims freed (the owner's free-namespaces).
  store.free = async function free (identity, names) {
    if (!names.length) { return; }
    await namespaces().updateMany(
      { _id: { $in: names }, 'holder.vendor': identity.vendor, 'holder.product': identity.product },
      { $set: { freed: true } }
    );
  };

  // Writes `after` in place of `before`: an insert when nothing was stored,
  // else a replace conditional on the etag read before; a delete when `after`
  // is null. Resolves true, or false when another write got there first.
  store.write = async function write (before, after) {
    const identity = (after || before).identity;
    if (!before) {
      try {
        await registrations().insertOne(Object.assign({}, after));
        return true;
      } catch (err) {
        if (isDuplicate(err)) { return false; }
        throw err;
      }
    }
    const filter = { 'identity.vendor': identity.vendor, 'identity.product': identity.product, etag: before.etag };
    if (!after) {
      const removed = await registrations().deleteOne(filter);
      return removed.deletedCount === 1;
    }
    const replaced = await registrations().replaceOne(filter, Object.assign({}, after));
    return replaced.matchedCount === 1;
  };

  return store;
}

module.exports = init;
module.exports.isDuplicate = isDuplicate;
