'use strict';
async function collectionIdentity (db, name) {
  const metadata = await db.listCollections({ name }, { nameOnly: false }).next();
  const uuid = metadata?.info?.uuid;
  if (metadata?.type !== 'collection' || !uuid || uuid.sub_type !== 4 || uuid.length() !== 16) {
    throw new Error('NATIVE_COLLECTION_UUID_REQUIRED');
  }
  return Object.freeze({ name, uuid: uuid.toString('hex') });
}
async function dropCollection (db, owned) {
  const current = await collectionIdentity(db, owned.name);
  if (current.uuid !== owned.uuid) throw new Error('NATIVE_COLLECTION_IDENTITY_CHANGED');
  await db.collection(owned.name).drop();
}
module.exports = { collectionIdentity, dropCollection };
