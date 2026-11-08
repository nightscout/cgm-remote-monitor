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

function createSecrets ({ providerFor, store, authorize, audit, maxTokenLifetimeSeconds, now = Date.now,
  legacyAuthorityFor }) {
  if (typeof providerFor !== 'function' || typeof authorize !== 'function' || typeof audit !== 'function' ||
      !store || typeof store.get !== 'function' ||
      (typeof store.insert !== 'function' && typeof store.compareAndSwapCiphertext !== 'function') ||
      !Number.isSafeInteger(maxTokenLifetimeSeconds) || maxTokenLifetimeSeconds < 1) {
    throw new TypeError('Secrets require a provider, tenant store, current authorization, audit and token lifetime bound');
  }

  async function access (context, operation, id, targetVersion) {
    // Transport authenticates these identities; this callback checks current authority on every operation.
    const identity = Object.freeze({
      tenant: name(context.tenant), principal: name(context.principal), consumer: name(context.consumer)
    });
    const action = Object.freeze({ operation, ...(id === undefined ? {} : { id: name(id) }),
      ...(targetVersion === undefined ? {} : { targetVersion }) });
    if (await authorize(identity, action) !== true) throw refuse('SECRETS_FORBIDDEN');
    // Await a durable, redacted audit receipt before any cryptographic effect or plaintext release.
    await audit(Object.freeze({ ...identity, ...action, phase: 'authorized', time: now() }));
    return { identity, provider: await providerFor(identity.tenant) };
  }

  async function read (context, reference, operation) {
    if (!reference || reference.tenant !== context.tenant) throw refuse('SECRETS_REFERENCE_MISMATCH');
    const id = name(reference.id);
    const { identity, provider } = await access(context, operation, id);
    const record = await store.get(identity.tenant, id);
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

  const canonicalTokens = new WeakMap();
  const component = Object.freeze({
    async verifyLegacyCredential (context, { apiSecret, token } = {}) {
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
      const root = await read(context, authority.reference, 'decrypt');
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
      // This is the shipping enclave's hash construction, not Transit HMAC.
      if (apiSecret && (apiSecret.toLowerCase() === sha1 || apiSecret === sha512)) {
        return Object.freeze({ kind: 'root' });
      }
      let accessToken;
      if (token) {
        try {
          accessToken = (await component.verifyJWT(context, token)).accessToken;
        } catch (error) {
          if (error.code !== 'SECRETS_TOKEN_INVALID') throw error;
        }
      }
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
      // Preserve JWT-first, api-secret-subject fallback after the root check.
      const subjects = match(accessToken || apiSecret);
      if (subjects.length !== 1) return null;
      const principal = Object.freeze({ kind: 'subject', subjectId: subjects[0].subjectId });
      canonicalTokens.set(principal,
        subjects[0].tokenPrefix + '-' + hash(sha1 + subjects[0].subjectId).slice(0, 16));
      return principal;
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
    async exchangeLegacyCredential (context, credential, currentSubject) {
      if (maxTokenLifetimeSeconds !== 28800) throw refuse('SECRETS_EXCHANGE_LIFETIME');
      if (typeof currentSubject !== 'function') throw new TypeError('Exchange requires current subject authority');
      const principal = await component.verifyLegacyCredential(context, { token: credential, apiSecret: credential });
      if (!principal || principal.kind !== 'subject') return null;
      if (await currentSubject(principal) !== true) return null;
      const token = await component.signJWT(context, canonicalTokens.get(principal), 28800);
      const { iat, exp } = await component.verifyJWT(context, token);
      return Object.freeze({ token, iat, exp });
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
    },
    async signJWT (context, accessToken, lifetimeSeconds) {
      name(accessToken);
      if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > maxTokenLifetimeSeconds) {
        throw refuse('SECRETS_TOKEN_LIFETIME');
      }
      const { identity, provider } = await access(context, 'sign');
      const keyVersion = provider.signingVersion;
      if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || keyVersion > 999999999) throw refuse('SECRETS_KEY_VERSION');
      const issued = Math.floor(now() / 1000);
      if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(issued + lifetimeSeconds)) {
        throw refuse('SECRETS_TOKEN_LIFETIME');
      }
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: String(keyVersion) })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        accessToken, aud: identity.tenant, iat: issued, exp: issued + lifetimeSeconds
      })).toString('base64url');
      const input = header + '.' + payload;
      const signature = await provider.sign(Buffer.from(input));
      if (!Buffer.isBuffer(signature) || signature.length !== 32) throw refuse('SECRETS_SIGNATURE_INVALID');
      return input + '.' + signature.toString('base64url');
    },
    async verifyJWT (context, token) {
      const { identity, provider } = await access(context, 'verify');
      if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        throw refuse('SECRETS_TOKEN_INVALID');
      }
      const parts = token.split('.');
      let header, payload;
      try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch { throw refuse('SECRETS_TOKEN_INVALID'); }
      const signature = Buffer.from(parts[2], 'base64url');
      if (!header || header.alg !== 'HS256' || header.typ !== 'JWT' || header.crit !== undefined ||
          typeof header.kid !== 'string' || !/^[1-9][0-9]{0,8}$/.test(header.kid) ||
          signature.length !== 32 || signature.toString('base64url') !== parts[2] ||
          !await provider.verify(Number(header.kid), Buffer.from(parts[0] + '.' + parts[1]), signature)) {
        throw refuse('SECRETS_TOKEN_INVALID');
      }
      const current = Math.floor(now() / 1000);
      if (!payload || payload.aud !== identity.tenant || !Number.isSafeInteger(payload.iat) ||
          !Number.isSafeInteger(payload.exp) || payload.iat > current || payload.exp <= current ||
          payload.exp <= payload.iat || payload.exp - payload.iat > maxTokenLifetimeSeconds ||
          typeof payload.accessToken !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.accessToken)) {
        throw refuse('SECRETS_TOKEN_INVALID');
      }
      // A verified token identifies a subject; it does not certify its current grants.
      return Object.freeze({ accessToken: payload.accessToken, iat: payload.iat, exp: payload.exp, aud: payload.aud });
    }
  });
  return component;
}

module.exports = { createSecrets };
