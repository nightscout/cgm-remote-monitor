'use strict';

const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const fail = code => Object.assign(new Error(code), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const namespaceValid = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
  value !== 'public' && value !== 'information_schema' && !value.startsWith('pg_');
const DEFAULTS = { denied: [], readable: ['*:*:read'], 'status-only': ['api:status:read'] };

function sessionFromRow (row) {
  if (!row) return null;
  return { id: row.session_id, tenant: row.tenant_id, subject: row.subject_id, purpose: row.purpose,
    issuer: row.issuer, providerSubject: row.provider_subject, providerSession: row.provider_session,
    authenticatedAt: Number(row.authenticated_at), createdAt: Number(row.created_at),
    absoluteExpiresAt: row.absolute_expires_at === null ? null : Number(row.absolute_expires_at),
    idleExpiresAt: row.idle_expires_at === null ? null : Number(row.idle_expires_at),
    active: row.active, authorityGeneration: row.authority_generation, credentialGeneration: row.credential_generation };
}

async function createPostgresStore ({ connectionString, namespace, authorityNamespace, accessNamespace, consumer }) {
  if (scope.getTenancyMode() !== 'multi' || ![namespace, authorityNamespace, accessNamespace].every(namespaceValid) ||
      typeof consumer !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(consumer)) {
    throw new TypeError('Multitenant human sessions require explicit namespaces and a trusted consumer');
  }
  const connection = await connect({ connectionString, max: 4, connectionTimeoutMillis: 1000,
    statement_timeout: 2000, query_timeout: 2000, application_name: 'nightscout-human-session' });
  const table = (schema, name) => '"' + schema + '".' + name;
  const identities = table(namespace, 'human_identities'), sessions = table(namespace, 'human_sessions');
  const tokens = table(namespace, 'human_access_tokens');
  const logoutEvents = table(namespace, 'human_logout_events');
  const tenants = table(accessNamespace, 'access_tenants'), credentials = table(accessNamespace, 'access_credentials');
  const subjects = table(authorityNamespace, 'tenant_authorization_subjects');
  const roles = table(authorityNamespace, 'tenant_authorization_roles');
  const links = table(authorityNamespace, 'tenant_authorization_subject_roles');
  const config = table(authorityNamespace, 'tenant_authorization_config');
  const actors = table(authorityNamespace, 'tenant_owner_actors');
  const required = [identities, sessions, tokens, logoutEvents, tenants, credentials, subjects, roles, links, config, actors];
  try {
    const result = await connection.withTenant('00000000-0000-0000-0000-000000000000', () => connection.query(`
      SELECT c.oid::regclass::text AS name, c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
        has_table_privilege(c.oid,'SELECT') AS reads,
        has_table_privilege(c.oid,'INSERT') AS inserts,
        has_table_privilege(c.oid,'UPDATE') AS updates,
        has_any_column_privilege(c.oid,'INSERT') AS column_inserts,
        has_any_column_privilege(c.oid,'UPDATE') AS column_updates,
        has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES') OR
          has_any_column_privilege(c.oid,'REFERENCES') AS unsafe
      FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [required]));
    if (result.rows.length !== required.length || result.rows.some(row => !row.secured || row.owns || !row.reads || row.unsafe ||
        row.inserts !== [sessions, tokens, logoutEvents].some(name => name.replaceAll('"', '') === row.name) ||
        row.column_inserts !== row.inserts || row.column_updates !== row.updates ||
        row.updates !== (row.name === sessions.replaceAll('"', '')))) throw fail('HUMAN_SESSION_STORE_UNSAFE');
  } catch (error) {
    await connection.end();
    throw fail(error.code === 'HUMAN_SESSION_STORE_UNSAFE' ? error.code : 'HUMAN_SESSION_UNAVAILABLE');
  }

  async function currentAuthority (tenant, issuer, providerSubject) {
    // One statement supplies a current, consistent identity/credential/grant
    // snapshot inside the session transaction. No worker-local grant cache.
    const result = await connection.query(`SELECT i.subject_id,i.enabled,i.purposes,i.generation,
      c.generation AS credential_generation,c.enabled AS credential_enabled,t.active,
      cfg.anonymous_roles,a.active AS owner_active,l.role_name,r.name AS found_role,r.permissions
      FROM ${identities} i
      JOIN ${tenants} t ON t.tenant_id=i.tenant_id
      JOIN ${credentials} c ON c.tenant_id=i.tenant_id AND c.credential_id=i.credential_id AND c.subject_id=i.subject_id
      JOIN ${subjects} s ON s.tenant_id=i.tenant_id AND s.subject_id=i.subject_id
      JOIN ${config} cfg ON cfg.tenant_id=i.tenant_id
      LEFT JOIN ${actors} a ON a.tenant_id=i.tenant_id AND a.principal=i.subject_id AND a.consumer=$4
      LEFT JOIN ${links} l ON l.tenant_id=i.tenant_id AND l.subject_id=i.subject_id
      LEFT JOIN ${roles} r ON r.tenant_id=l.tenant_id AND r.name=l.role_name
      WHERE i.tenant_id=$1 AND i.issuer=$2 AND i.provider_subject=$3 ORDER BY l.role_name`,
    [tenant, issuer, providerSubject, consumer]);
    if (!result.rows.length) return null;
    const first = result.rows[0];
    if (!Array.isArray(first.anonymous_roles) || first.anonymous_roles.some(role => !Object.hasOwn(DEFAULTS, role)) ||
        !Array.isArray(first.purposes)) throw fail('HUMAN_SESSION_UNAVAILABLE');
    const groups = first.anonymous_roles.map(role => DEFAULTS[role]);
    for (const row of result.rows) {
      if (row.role_name === null) continue;
      if (row.found_role !== row.role_name || !Array.isArray(row.permissions)) throw fail('HUMAN_SESSION_UNAVAILABLE');
      groups.push(row.permissions);
    }
    return { active: first.active && first.enabled && first.credential_enabled,
      subject: first.subject_id, consumer, generation: first.generation,
      credentialGeneration: first.credential_generation,
      purposes: first.purposes.filter(purpose => purpose !== 'management' || first.owner_active === true), permissionGroups: groups };
  }

  return Object.freeze({
    async transaction (request, work) {
      if (!request || typeof request.tenant !== 'string' || !UUID.test(request.tenant) || typeof work !== 'function') {
        throw fail('HUMAN_SESSION_REFUSED');
      }
      if (!request.identity && (typeof request.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.tokenHash))) {
        throw fail('HUMAN_SESSION_REFUSED');
      }
      try {
        return await connection.withTenant(request.tenant, async () => {
          await connection.query("SET LOCAL synchronous_commit='on'");
          let row;
          if (request.tokenHash) {
            const result = await connection.query(`SELECT s.*,t.expires_at AS token_expires_at FROM ${tokens} t
              JOIN ${sessions} s ON s.tenant_id=t.tenant_id AND s.session_id=t.session_id
              WHERE t.tenant_id=$1 AND t.token_hash=$2 FOR UPDATE OF s`, [request.tenant, request.tokenHash]);
            row = result.rows[0];
          }
          const identity = request.identity || row && { issuer: row.issuer, subject: row.provider_subject };
          const authority = identity ? await currentAuthority(request.tenant, identity.issuer, identity.subject) : null;
          const tx = {
            session: sessionFromRow(row), token: row ? { expiresAt: Number(row.token_expires_at) } : null, authority,
            async save (session, token) {
              if (session.tenant !== request.tenant) throw fail('HUMAN_SESSION_REFUSED');
              if (!row) {
                await connection.query(`INSERT INTO ${sessions} (tenant_id,session_id,subject_id,purpose,issuer,provider_subject,
                  provider_session,authenticated_at,created_at,absolute_expires_at,idle_expires_at,active,authority_generation,credential_generation)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                [session.tenant,session.id,session.subject,session.purpose,session.issuer,session.providerSubject,
                  session.providerSession,session.authenticatedAt,session.createdAt,session.absoluteExpiresAt,session.idleExpiresAt,
                  session.active,session.authorityGeneration,session.credentialGeneration]);
              } else {
                const changed = await connection.query(`UPDATE ${sessions} SET idle_expires_at=$3
                  WHERE tenant_id=$1 AND session_id=$2 AND active`, [session.tenant,session.id,session.idleExpiresAt]);
                if (changed.rowCount !== 1) throw fail('HUMAN_SESSION_REFUSED');
              }
              if (token) await connection.query(`INSERT INTO ${tokens} (tenant_id,token_hash,session_id,expires_at)
                VALUES ($1,$2,$3,$4)`, [session.tenant,token.hash,session.id,token.expiresAt]);
            },
            async revoke () {
              if (row) await connection.query(`UPDATE ${sessions} SET active=false WHERE tenant_id=$1 AND session_id=$2`,
                [request.tenant,row.session_id]);
            }
          };
          return work(tx);
        });
      } catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('HUMAN_')) throw error;
        throw fail('HUMAN_SESSION_UNAVAILABLE');
      }
    },
    async revokeProvider ({ tenant, issuer, eventId, issuedAt, providerSession, subject }) {
      if (typeof tenant !== 'string' || !UUID.test(tenant)) throw fail('HUMAN_SESSION_REFUSED');
      try {
        return await connection.withTenant(tenant, async () => {
          await connection.query("SET LOCAL synchronous_commit='on'");
          const inserted = await connection.query(`INSERT INTO ${logoutEvents} (tenant_id,issuer,event_id,issued_at)
            VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`, [tenant,issuer,eventId,issuedAt]);
          if (!inserted.rowCount) return Object.freeze({ revoked: 0, replayed: true });
          const changed = await connection.query(`UPDATE ${sessions} SET active=false
            WHERE tenant_id=$1 AND issuer=$2 AND ($3::text IS NULL OR provider_session=$3)
            AND ($4::text IS NULL OR provider_subject=$4) AND created_at<=$5 AND active`,
          [tenant,issuer,providerSession || null,subject || null,issuedAt]);
          return Object.freeze({ revoked: changed.rowCount, replayed: false });
        });
      } catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('HUMAN_')) throw error;
        throw fail('HUMAN_SESSION_UNAVAILABLE');
      }
    },
    close () { return connection.end(); }
  });
}

module.exports = { createPostgresStore };
