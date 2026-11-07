'use strict';

// Optional serving composition only. Existing preview configurations need no
// settings namespace, credentials or migrations unless this object is selected.
module.exports = function settingsConfig (value, source, existing, { owner = false, invalid }) {
  if (value === undefined) return undefined;
  const fields = owner ? ['settings', 'operatorPolicy', 'authority'] : ['settings', 'operatorPolicy'];
  const exact = (input, keys) => input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
  if (!exact(value, ['connectionEnv', 'namespaces']) || !exact(value.namespaces, fields) ||
      typeof value.connectionEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.connectionEnv) ||
      typeof source[value.connectionEnv] !== 'string' || !source[value.connectionEnv].trim()) invalid();
  const names = Object.values(value.namespaces);
  if (new Set(names).size !== names.length || names.some(name => typeof name !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(name) || name === 'public' || name === 'information_schema' ||
      name.startsWith('pg_') || Object.values(existing.namespaces).includes(name))) invalid();
  const connectionString = source[value.connectionEnv];
  let url;
  try { url = new URL(connectionString); } catch { invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1 ||
      url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode'))) invalid();
  for (const address of existing.connections) {
    const other = new URL(address);
    let sameUser;
    try { sameUser = decodeURIComponent(url.username) === decodeURIComponent(other.username); } catch { invalid(); }
    if (sameUser || url.hostname !== other.hostname || url.port !== other.port ||
        url.pathname !== other.pathname) invalid();
  }
  return { connectionString, namespaces: { ...value.namespaces } };
};
