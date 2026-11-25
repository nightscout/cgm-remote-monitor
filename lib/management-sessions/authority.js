'use strict';

// Fixed authority read/lock capability. The installer pins its search_path to
// reviewed namespaces; no caller supplies a namespace or changes tenant scope.
const BODY = `
DECLARE bound uuid := nullif(current_setting('app.current_tenant_id',true),'')::uuid;
BEGIN
  IF bound IS NULL OR bound <> target_tenant THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  PERFORM w.tenant_id FROM tenant_lifecycle_windows w WHERE w.tenant_id=bound AND w.phase='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  PERFORM a.tenant_id FROM tenant_activity a WHERE a.tenant_id=bound AND NOT a.suspended AND a.deletion_request_id IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  PERFORM c.tenant_id FROM tenant_authorization_config c WHERE c.tenant_id=bound FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  PERFORM p.tenant_id FROM tenant_owner_policy p WHERE p.tenant_id=bound FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  PERFORM a.principal FROM tenant_owner_actors a WHERE a.tenant_id=bound AND a.principal=target_subject
    AND a.consumer=target_consumer AND a.active AND a.can_update FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  PERFORM s.subject_id FROM tenant_authorization_subjects s WHERE s.tenant_id=bound AND s.subject_id=target_subject
    AND s.display_name IS NOT NULL AND length(btrim(s.display_name))>0 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  PERFORM r.tenant_id FROM tenant_registry r WHERE r.tenant_id=bound AND r.state='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  PERFORM t.tenant_id FROM access_tenants t WHERE t.tenant_id=bound AND t.active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
  RETURN QUERY SELECT k.kid,k.public_key FROM tenant_registry_keys k JOIN access_keys a
    ON a.tenant_id=k.tenant_id AND a.kid=k.kid AND a.purpose='management' AND a.active
    WHERE k.tenant_id=bound AND k.purpose='management' FOR SHARE OF k,a;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANAGEMENT_SESSION_REFUSED'; END IF;
END`;
const FUNCTION = 'management_session_authority';
const SIGNATURE = '(uuid,text,text)';
const CREATE = 'CREATE FUNCTION ' + FUNCTION + '(target_tenant uuid,target_subject text,target_consumer text) RETURNS TABLE(kid text,public_key text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$' + BODY + '$fn$';
const OWNER = Object.freeze({
  authorization: { tenant_authorization_config: 'owner_fence', tenant_owner_policy: 'owner_fence', tenant_owner_actors: 'active', tenant_authorization_subjects: 'display_name' },
  registry: { tenant_registry: 'state', tenant_registry_keys: 'public_key' },
  access: { access_tenants: 'active', access_keys: 'active' },
  control: { tenant_lifecycle_windows: null, tenant_activity: 'version' }
});
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const validName = value => typeof value === 'string' && NAME.test(value) && value !== 'public' && value !== 'information_schema' && !value.startsWith('pg_');
const q = value => { if (!validName(value)) throw new TypeError('Explicit non-system management session identifier required'); return '"' + value + '"'; };
function selected (namespaces) {
  if (!namespaces || Object.keys(namespaces).length !== 4 || !['authorization', 'registry', 'access', 'control'].every(kind => validName(namespaces[kind])) || new Set(Object.values(namespaces)).size !== 4) {
    throw new TypeError('Explicit distinct management session namespaces required');
  }
  return namespaces;
}
const searchPath = namespaces => ['pg_catalog', ...['authorization', 'registry', 'access', 'control'].map(kind => selected(namespaces)[kind])];
function grants ({ namespaces, issuer, authorityOwner }) {
  selected(namespaces); q(issuer); q(authorityOwner);
  if (issuer === authorityOwner) throw new TypeError('Separate management issuer and NOLOGIN authority owner required');
  const functionName = q(namespaces.access) + '.' + FUNCTION + SIGNATURE;
  const owner = ['ALTER FUNCTION ' + functionName + ' OWNER TO ' + q(authorityOwner),
    'ALTER FUNCTION ' + functionName + ' SET search_path TO ' + searchPath(namespaces).map(qName => qName === 'pg_catalog' ? 'pg_catalog' : q(qName)).join(',')];
  for (const [kind, tables] of Object.entries(OWNER)) {
    owner.push('GRANT USAGE ON SCHEMA ' + q(namespaces[kind]) + ' TO ' + q(authorityOwner));
    for (const [table, column] of Object.entries(tables)) owner.push('GRANT SELECT' + (column ? ',UPDATE(' + column + ')' : '') + ' ON ' + q(namespaces[kind]) + '.' + table + ' TO ' + q(authorityOwner));
  }
  const access = q(namespaces.access), who = q(issuer);
  const login = [...Object.values(namespaces).map(namespace => 'GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + who),
    'GRANT SELECT ON ' + access + '.schema_migrations,' + access + '.access_credentials,' + access + '.access_sessions,' + access + '.management_session_requests TO ' + who,
    'GRANT INSERT ON ' + access + '.access_credentials,' + access + '.access_sessions,' + access + '.management_session_requests TO ' + who,
    'GRANT UPDATE(enabled,generation) ON ' + access + '.access_credentials TO ' + who,
    'GRANT UPDATE(active,expires_at,generation) ON ' + access + '.access_sessions TO ' + who,
    ...require('../tenant-lifecycle/tenant-phase').phaseGrants({ namespace: namespaces.control, role: issuer }),
    'GRANT EXECUTE ON FUNCTION ' + functionName + ' TO ' + who];
  return Object.freeze({ authorityOwner: Object.freeze(owner), issuer: Object.freeze(login) });
}
module.exports = { BODY, FUNCTION, SIGNATURE, CREATE, OWNER, validName, q, selected, searchPath, grants };
