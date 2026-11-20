'use strict';

const { createHash } = require('node:crypto');

function refuse (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function name (value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Invalid secrets identity');
  }
  return value;
}

// Tenant secret custody (Transit `data` key). Token signing is not a secrets
// operation: tenant signing keys are derived in process (decision
// deployment-signing-secret); the HS256 profile is retired.
function createSecrets ({ providerFor, store, authorize, audit, maxTokenLifetimeSeconds, now = Date.now,
  legacyAuthorityFor, auditRead }) {
  if (typeof providerFor !== 'function' || typeof authorize !== 'function' || typeof audit !== 'function' ||
      !store || typeof store.get !== 'function' ||
      (typeof store.insert !== 'function' && typeof store.compareAndSwapCiphertext !== 'function') ||
      (auditRead !== undefined && typeof auditRead !== 'function') ||
      !Number.isSafeInteger(maxTokenLifetimeSeconds) || maxTokenLifetimeSeconds < 1) {
    throw new TypeError('Secrets require a provider, tenant store, current authorization, audit and token lifetime bound');
  }

  async function authorizeAccess (context, operation, id, targetVersion, legacyAuthority) {
    // Transport authenticates these identities; this callback checks current authority on every operation.
    const identity = Object.freeze({
      tenant: name(context.tenant), principal: name(context.principal), consumer: name(context.consumer)
    });
    const action = Object.freeze({ operation, ...(id === undefined ? {} : { id: name(id) }),
      ...(targetVersion === undefined ? {} : { targetVersion }) });
    if (await authorize(identity, action, legacyAuthority) !== true) throw refuse('SECRETS_FORBIDDEN');
    return { identity, event: Object.freeze({ ...identity, ...action, phase: 'authorized', time: now() }) };
  }

  async function access (context, operation, id, targetVersion, legacyAuthority) {
    const { identity, event } = await authorizeAccess(context, operation, id, targetVersion, legacyAuthority);
    // Await a durable, redacted receipt before any cryptographic effect.
    await audit(event);
    return { identity, provider: await providerFor(identity.tenant) };
  }

  async function read (context, reference, operation, legacyAuthority) {
    if (!reference || reference.tenant !== context.tenant) throw refuse('SECRETS_REFERENCE_MISMATCH');
    const id = name(reference.id);
    let identity, provider, record;
    if (auditRead) {
      const admitted = await authorizeAccess(context, operation, id, undefined, legacyAuthority);
      identity = admitted.identity;
      // This private persistence primitive commits the receipt and ciphertext
      // read together; no provider effect precedes its successful COMMIT.
      record = await auditRead(admitted.event);
      provider = await providerFor(identity.tenant);
    } else {
      ({ identity, provider } = await access(context, operation, id, undefined, legacyAuthority));
      record = await store.get(identity.tenant, id);
    }
    if (!record) throw refuse('SECRETS_NOT_FOUND');
    if (record.format !== 1 || record.tenant !== identity.tenant || record.id !== id) {
      throw refuse('SECRETS_RECORD_INVALID');
    }
    const bytes = await provider.decrypt(record.ciphertext);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw refuse('SECRETS_RECORD_INVALID'); }
    // The authenticated plaintext binds ciphertext to its immutable tenant and reference.
    if (!value || value.tenant !== identity.tenant || value.id !== id ||
        typeof value.data !== 'string' || Buffer.from(value.data, 'base64').toString('base64') !== value.data) {
      throw refuse('SECRETS_RECORD_INVALID');
    }
    return Buffer.from(value.data, 'base64');
  }

  const component = Object.freeze({
    async verifyLegacyCredential (context, { apiSecret, token } = {}, acceptLegacySubject) {
      if (acceptLegacySubject !== undefined && typeof acceptLegacySubject !== 'function') throw new TypeError('Current legacy subject callback required');
      if (apiSecret === undefined && token === undefined) return Object.freeze({ kind: 'anonymous' });
      if ([apiSecret, token].some(value => value !== undefined &&
          (typeof value !== 'string' || !value.length || value.length > 8192))) {
        return null;
      }
      if (typeof legacyAuthorityFor !== 'function') throw refuse('SECRETS_OPERATION_UNSUPPORTED');
      // Only trusted provisioning supplies this fresh reference and imported
      // credential metadata. Neither a request nor a JWT selects root or IDs.
      const authority = await legacyAuthorityFor(name(context.tenant));
      if (!authority || !authority.reference || !Array.isArray(authority.subjects) ||
          authority.subjects.some(subject => !subject ||
            typeof subject.subjectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(subject.subjectId) ||
            typeof subject.tokenPrefix !== 'string' || !/^[a-z0-9_]{0,10}$/.test(subject.tokenPrefix)) ||
          new Set(authority.subjects.map(subject => subject.subjectId)).size !== authority.subjects.length) {
        throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
      }
      const root = await read(context, authority.reference, 'decrypt', authority);
      const hash = (value, algorithm = 'sha1') => createHash(algorithm).update(value).digest('hex');
      let sha1, sha512;
      try {
        if (root.toString('utf8').length < 12 || !root.equals(Buffer.from(root.toString('utf8')))) {
          throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
        }
        sha1 = hash(root);
        // Only a 128-character root credential can match SHA-512. Subject
        // tokens still derive from SHA-1; do not compute an unused root hash.
        if (apiSecret && apiSecret.length === 128) sha512 = hash(root, 'sha512');
      } finally {
        root.fill(0);
      }
      // This is the shipping enclave's hash construction, not Transit HMAC.
      const rootMatches = apiSecret && (apiSecret.toLowerCase() === sha1 || apiSecret === sha512);
      if (rootMatches && !acceptLegacySubject) return Object.freeze({ kind: 'root' });
      const match = credential => {
        if (!credential) return [];
        const suffix = credential.split('-').at(-1);
        if (suffix.length < 16) return [];
        return authority.subjects.filter(subject => {
          const digest = hash(sha1 + subject.subjectId);
          const derived = subject.tokenPrefix + '-' + digest.slice(0, 16);
          return hash(derived).startsWith(credential) || digest.startsWith(suffix);
        });
      };
      const identified = subject => Object.freeze({ kind: 'subject', subjectId: subject.subjectId });
      // Mixed DATA credentials used to issue a JWT before checking api-secret.
      // Retain that path's actual refusal for an unknown or no-longer-current
      // query token, including when api-secret is root; never silently widen a
      // grant while removing the issuance work. Root wins after token admission.
      // A dotted token is a JWT, which this verifier never accepts (the HS256
      // profile is retired; data JWTs are verified locally with public keys).
      const tokenSubjects = match(acceptLegacySubject && token && !token.includes('.') ? token : undefined);
      if (tokenSubjects.length === 1) {
        const principal = identified(tokenSubjects[0]);
        if (!acceptLegacySubject) return principal;
        if (await acceptLegacySubject(principal) !== true) return null;
        return rootMatches ? Object.freeze({ kind: 'root' }) : principal;
      }
      if (acceptLegacySubject) return null;
      const subjects = match(apiSecret);
      return subjects.length === 1 ? identified(subjects[0]) : null;
    },
    // Single-site admin tools list each subject's access token to the root
    // secret holder. Derivation is released only when the presented secret is
    // this tenant's current root, in the same decrypt; the token is a function
    // of that secret, so this confers nothing the root holder lacks.
    async rootLegacyTokens (context, { apiSecret } = {}) {
      if (typeof apiSecret !== 'string' || !apiSecret.length || apiSecret.length > 8192) return null;
      if (typeof legacyAuthorityFor !== 'function') throw refuse('SECRETS_OPERATION_UNSUPPORTED');
      const authority = await legacyAuthorityFor(name(context.tenant));
      if (!authority || !authority.reference || !Array.isArray(authority.subjects) ||
          authority.subjects.some(subject => !subject ||
            typeof subject.subjectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(subject.subjectId) ||
            typeof subject.tokenPrefix !== 'string' || !/^[a-z0-9_]{0,10}$/.test(subject.tokenPrefix)) ||
          new Set(authority.subjects.map(subject => subject.subjectId)).size !== authority.subjects.length) {
        throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
      }
      const root = await read(context, authority.reference, 'decrypt', authority);
      const hash = (value, algorithm = 'sha1') => createHash(algorithm).update(value).digest('hex');
      let sha1, sha512;
      try {
        if (root.toString('utf8').length < 12 || !root.equals(Buffer.from(root.toString('utf8')))) {
          throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
        }
        sha1 = hash(root);
        sha512 = hash(root, 'sha512');
      } finally {
        root.fill(0);
      }
      if (apiSecret.toLowerCase() !== sha1 && apiSecret !== sha512) return null;
      return new Map(authority.subjects.map(subject =>
        [subject.subjectId, subject.tokenPrefix + '-' + hash(sha1 + subject.subjectId).slice(0, 16)]));
    },
    // A subject whose current roles grant admin:api:subjects:read lists every
    // subject's token, as the single-site admin tools do (decision
    // admin-role-subjects-use-admin-tools). The caller's current-authority check
    // runs before any decrypt; anything but true releases nothing.
    async adminLegacyTokens (context, currentAuthority) {
      if (typeof currentAuthority !== 'function') throw new TypeError('Token listing requires current admin authority');
      if (typeof legacyAuthorityFor !== 'function') throw refuse('SECRETS_OPERATION_UNSUPPORTED');
      if (await currentAuthority() !== true) return null;
      const authority = await legacyAuthorityFor(name(context.tenant));
      if (!authority || !authority.reference || !Array.isArray(authority.subjects) ||
          authority.subjects.some(subject => !subject ||
            typeof subject.subjectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(subject.subjectId) ||
            typeof subject.tokenPrefix !== 'string' || !/^[a-z0-9_]{0,10}$/.test(subject.tokenPrefix)) ||
          new Set(authority.subjects.map(subject => subject.subjectId)).size !== authority.subjects.length) {
        throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
      }
      const root = await read(context, authority.reference, 'decrypt', authority);
      let sha1;
      try {
        if (root.toString('utf8').length < 12 || !root.equals(Buffer.from(root.toString('utf8')))) {
          throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
        }
        sha1 = createHash('sha1').update(root).digest('hex');
      } finally {
        root.fill(0);
      }
      return new Map(authority.subjects.map(subject => [subject.subjectId,
        subject.tokenPrefix + '-' + createHash('sha1').update(sha1 + subject.subjectId).digest('hex').slice(0, 16)]));
    },
    async issueLegacyCredential (context, subjectId, withCurrentSubject) {
      name(subjectId);
      if (typeof legacyAuthorityFor !== 'function') throw refuse('SECRETS_OPERATION_UNSUPPORTED');
      if (typeof withCurrentSubject !== 'function') {
        throw new TypeError('Issuance requires current subject and management authority fencing');
      }
      const tenant = name(context.tenant);
      let issued, invoked = false;
      // The trusted wrapper holds current management, delegation, subject and
      // credential locks through derivation and resolves only after its commit.
      const result = await withCurrentSubject(Object.freeze({ tenant, subjectId }), async () => {
        if (invoked) throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
        invoked = true;
        const authority = await legacyAuthorityFor(tenant);
        if (!authority || !authority.reference || !Array.isArray(authority.subjects) ||
            authority.subjects.some(subject => !subject ||
              typeof subject.subjectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(subject.subjectId) ||
              typeof subject.tokenPrefix !== 'string' || !/^[a-z0-9_]{0,10}$/.test(subject.tokenPrefix)) ||
            new Set(authority.subjects.map(subject => subject.subjectId)).size !== authority.subjects.length) {
          throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
        }
        const subject = authority.subjects.find(subject => subject.subjectId === subjectId);
        if (!subject) throw refuse('SECRETS_NOT_FOUND');
        // Separate issuance authority, including fresh authentication at its
        // trusted caller, never promotes a decrypt or data grant into issuance.
        const root = await read(context, authority.reference, 'issue-legacy');
        try {
          if (root.toString('utf8').length < 12 || !root.equals(Buffer.from(root.toString('utf8')))) {
            throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
          }
          const rootHash = createHash('sha1').update(root).digest('hex');
          const suffix = createHash('sha1').update(rootHash + subjectId).digest('hex').slice(0, 16);
          issued = Object.freeze({ token: subject.tokenPrefix + '-' + suffix });
          return issued;
        } finally { root.fill(0); }
      });
      // Missing/rejected fence callbacks cannot release a derived credential.
      if (!issued || result !== issued) throw refuse('SECRETS_FORBIDDEN');
      return result;
    },
    // Management/provisioning only. Its caller fences current subject writes;
    // ordinary DATA receives only the one-way verifier adapter, not this port.
    async deriveLegacyVerifiers (context, subjects) {
      if (typeof legacyAuthorityFor !== 'function') throw refuse('SECRETS_OPERATION_UNSUPPORTED');
      const authority = await legacyAuthorityFor(name(context.tenant));
      if (!authority?.reference) throw refuse('SECRETS_LEGACY_AUTHORITY_INVALID');
      const root = await read(context, authority.reference, 'issue-legacy');
      try { return require('./legacy-verifiers').prepare(root, subjects); }
      finally { root.fill(0); }
    },
    async encrypt (context, id, plaintext) {
      if (typeof store.insert !== 'function') throw refuse('SECRETS_OPERATION_UNSUPPORTED');
      if (!Buffer.isBuffer(plaintext)) throw new TypeError('Plaintext must be a Buffer');
      const { identity, provider } = await access(context, 'encrypt', id);
      const ciphertext = await provider.encrypt(Buffer.from(JSON.stringify({
        tenant: identity.tenant, id, data: plaintext.toString('base64')
      })));
      // insert must enforce tenant/id uniqueness; rotation must not silently overwrite a reference.
      await store.insert(Object.freeze({ format: 1, tenant: identity.tenant, id, ciphertext }));
      return Object.freeze({ tenant: identity.tenant, id });
    },
    decrypt (context, reference) { return read(context, reference, 'decrypt'); },
    reveal (context, reference) { return read(context, reference, 'reveal'); },
    async rewrap (context, reference, targetVersion) {
      if (typeof store.compareAndSwapCiphertext !== 'function') throw refuse('SECRETS_OPERATION_UNSUPPORTED');
      if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) throw new TypeError('Invalid target key version');
      if (!reference || reference.tenant !== context.tenant) throw refuse('SECRETS_REFERENCE_MISMATCH');
      const id = name(reference.id);
      const { identity, provider } = await access(context, 'rewrap', id, targetVersion);
      if (typeof provider.rewrap !== 'function') throw refuse('SECRETS_OPERATION_UNSUPPORTED');
      const record = await store.get(identity.tenant, id);
      if (!record) throw refuse('SECRETS_NOT_FOUND');
      if (record.format !== 1 || record.tenant !== identity.tenant || record.id !== id ||
          typeof record.ciphertext !== 'string') throw refuse('SECRETS_RECORD_INVALID');
      const ciphertext = await provider.rewrap(record.ciphertext, targetVersion);
      if (typeof ciphertext !== 'string' || !ciphertext.length) throw refuse('SECRETS_RECORD_INVALID');
      // CAS is required even on a no-op, to establish that this is still the stored ciphertext.
      if (await store.compareAndSwapCiphertext(identity.tenant, id, record.ciphertext, ciphertext) !== true) {
        throw refuse('SECRETS_REWRAP_CONFLICT');
      }
      return Object.freeze({ tenant: identity.tenant, id });
    }
  });
  return component;
}

module.exports = { createSecrets };
