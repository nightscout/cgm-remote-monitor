'use strict';

const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const ConnectError = require('./errors');
const sessionMachine = require('./session-machine');
const { capture } = require('./sources/carelink/auth');
const { transform } = require('./sources/carelink/transform');

class Manager {
  constructor({ store, auth, client, browser, output, conflicts = () => [], stopLegacy = async () => {} }) {
    Object.assign(this, { store, auth, client, browser, output, conflicts, stopLegacy });
    this.connection = null;
    this.session = null;
    this.closed = false;
    this.failures = 0;
  }
  async init() {
    try { this.connection = await this.store.load(); }
    catch (err) { this.error = err.code || 'storage_unavailable'; }
    if (this.connection) this.schedule(1000);
  }
  status(owner) {
    const c = this.connection;
    return { source: 'carelink', connected: !!c?.enabled && !c.needsLogin, configured: !!c?.enabled,
      country: c && c.country, patient: c && c.patientLabel,
      lastSync: c && c.lastSync, lastReading: c && c.lastReading,
      error: this.error || (c && c.needsLogin ? 'reconnect_required' : null),
      available: this.browser.available(), conflicts: this.conflicts(),
      session: this.session && this.session.owner === owner ? this.sessionStatus(this.session) : null,
      busy: !!(this.session && (!this.session.machine.state.done || this.session.opening || this.session.closing)) };
  }
  sessionStatus(s) {
    return { id: s.id, state: s.machine.state.value, error: s.error || null,
      phase: s.phase || null, diagnostic: ConnectError.safeDiagnostic(s.diagnostic) || null,
      expiresAt: s.expiresAt, width: s.width, height: s.height,
      blockedHosts: s.blockedHosts || [],
      patients: s.machine.state.matches('selecting') ? s.account.patients : [],
      focus: s.focus || null };
  }
  own(id, owner) {
    const s = this.session;
    if (!s || s.id !== id || s.owner !== owner) throw new ConnectError('session_not_found', 404);
    s.lastSeen = Date.now();
    return s;
  }
  async start(owner, { country, width = 1000, height = 800, replace = false } = {}) {
    replace = replace === true;
    if (this.closed) throw new ConnectError('worker_unavailable', 503);
    if (!this.browser.available()) throw new ConnectError('worker_unavailable', 503);
    if (this.session && (!this.session.machine.state.done || this.session.opening || this.session.closing)) throw new ConnectError('login_in_progress', 409);
    if (this.conflicts().length && !replace) throw new ConnectError('source_conflict', 409);
    if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) throw new ConnectError('invalid_country');
    width = Math.round(Math.max(320, Math.min(1280, Number(width) || 1000)));
    height = Math.round(Math.max(480, Math.min(1000, Number(height) || 800)));
    const s = { id: crypto.randomBytes(24).toString('base64url'), owner, width, height, country, replace,
      machine: sessionMachine(), events: new EventEmitter(), seq: 0, lastSeen: Date.now(), lastInput: Date.now(),
      expiresAt: Date.now() + 10 * 60000, frame: null };
    this.session = s;
    s.watchdog = setInterval(() => {
      const now = Date.now();
      if (now > s.expiresAt || now - s.lastInput > 3 * 60000 || now - s.lastSeen > 45000) void this.end(s, 'EXPIRE');
    }, 5000);
    s.watchdog.unref();
    // Return promptly; status polling reports asynchronous startup errors.
    s.opening = true;
    void this.open(s).finally(() => { s.opening = false; });
    return this.sessionStatus(s);
  }
  async open(s) {
    try {
      s.transaction = await this.auth.begin(s.country);
      if (s.machine.state.done) return;
      s.worker = await this.browser.open({ url: s.transaction.url, width: s.width, height: s.height,
        onFrame: frame => {
          if (!s.machine.state.matches('waiting')) return;
          s.frame = frame; s.seq++; s.events.emit('frame');
        },
        onRedirect: url => { void this.callback(s, url); },
        onBlocked: host => {
          if (!/^[a-z0-9.-]{1,253}$/.test(host)) return;
          s.blockedHosts = [...new Set([...(s.blockedHosts || []), host])].slice(0, 12);
        },
        onError: () => { void this.end(s, 'FAIL', 'worker_unavailable'); }
      });
      if (s.machine.state.done || s.machine.state.matches('exchanging')) { await s.worker.close(); s.worker = null; }
      else s.machine.send('READY');
    } catch (err) { s.diagnostic = ConnectError.safeDiagnostic(err.diagnostic); await this.end(s, 'FAIL', err.code || 'worker_unavailable'); }
  }
  async callback(s, url) {
    if (!['starting', 'waiting'].includes(s.machine.state.value)) return;
    try {
      const transaction = s.transaction;
      const code = capture(url, transaction.state);
      if (!code) return;
      s.machine.send('CALLBACK'); // consume before asynchronous exchange
      s.phase = 'token_exchange';
      s.frame = null; s.events.emit('frame');
      if (s.worker) await s.worker.close();
      const tokens = await this.auth.exchange(transaction, code);
      if (s.machine.state.done) return;
      s.candidate = { country: s.country, region: transaction.region, tokens };
      s.transaction = null;
      s.phase = 'account_lookup';
      s.account = await this.client.account(s.candidate);
      if (s.machine.state.done) { s.candidate = null; return; }
      s.machine.send('SELECT');
      // Even a single eligible account is shown before the user confirms it.
    } catch (err) { s.diagnostic = ConnectError.safeDiagnostic(err.diagnostic); await this.end(s, 'FAIL', err.code || 'provider_unavailable'); }
  }
  async select(id, owner, patient) {
    const s = this.own(id, owner);
    if (!s.machine.state.matches('selecting')) throw new ConnectError('invalid_session_state', 409);
    const selected = s.account.patients.find(p => p.username === patient);
    if (!selected) throw new ConnectError('invalid_patient');
    s.machine.send('SAVE');
    try {
      await this.store.exclusive(async check => {
        if (s.machine.state.done) throw new ConnectError('session_expired', 409);
        const next = { ...s.candidate, patient, patientLabel: selected.label, enabled: true,
          replacesLegacy: !!s.replace, connectedAt: Date.now() };
        await check();
        await this.store.save(next); // failure leaves the old connection intact
        await this.stopLegacy();
        this.connection = next; this.error = null; this.failures = 0;
      });
      await this.end(s, 'DONE');
      this.schedule(0);
      return this.status(owner);
    } catch (err) { await this.end(s, 'FAIL', err.code || 'storage_unavailable'); throw err; }
  }
  async input(id, owner, input) {
    const s = this.own(id, owner);
    if (!s.machine.state.matches('waiting') || !s.worker) throw new ConnectError('invalid_session_state', 409);
    s.lastInput = Date.now();
    s.focus = await s.worker.input(input);
    return { focus: s.focus };
  }
  async end(s, event, error) {
    if (s.machine.state.done) return;
    // Finishing persistence cannot be interrupted halfway by cancellation.
    if (s.machine.state.matches('saving') && ['CANCEL', 'EXPIRE'].includes(event)) return;
    s.machine.send(event);
    s.error = error;
    clearInterval(s.watchdog);
    s.frame = null; s.events.emit('frame');
    s.transaction = null; s.candidate = null; s.account = null;
    if (s.worker) {
      s.closing = true;
      const worker = s.worker; s.worker = null;
      try { await worker.close().catch(() => {}); } finally { s.closing = false; }
    }
  }
  async cancel(id, owner) { await this.end(this.own(id, owner), 'CANCEL'); }
  async disconnect() {
    if (this.session && !this.session.machine.state.done) {
      if (this.session.machine.state.matches('saving')) throw new ConnectError('connection_busy', 409);
      await this.end(this.session, 'CANCEL');
    }
    clearTimeout(this.timer);
    await this.store.exclusive(async check => {
      await check();
      // Keep only source ownership, never tokens/patient identity. Otherwise
      // old environment credentials could silently resume after a restart.
      const disconnected = { enabled: false, replacesLegacy: true };
      await this.store.save(disconnected);
      this.connection = disconnected; this.error = null;
    });
    clearTimeout(this.timer);
  }
  schedule(delay) {
    clearTimeout(this.timer);
    if (!this.closed && this.connection?.enabled && !this.connection.needsLogin) {
      this.timer = setTimeout(() => { void this.poll(); }, delay);
      this.timer.unref();
    }
  }
  async poll() {
    if (this.closed) return;
    try {
      await this.store.exclusive(async check => {
        const c = await this.store.load();
        this.connection = c;
        if (!c?.enabled || c.needsLogin || this.closed) return;
        try {
          if (c.tokens.expiresAt < Date.now() + 60000) {
            c.tokens = await this.auth.refresh(c.tokens);
            await check();
            await this.store.save(c); // persist rotation before using the token
          }
          const account = await this.client.account(c);
          const payload = await this.client.data(c, account);
          const batch = transform(payload, c.patient);
          if (c.lastReading) batch.entries = batch.entries.filter(e => e.date >= c.lastReading - 600000);
          await check();
          if (this.closed) return;
          await this.output(batch);
          c.lastSync = Date.now();
          c.lastReading = Math.max(c.lastReading || 0, ...batch.entries.map(e => e.date)) || null;
          await check(); await this.store.save(c);
          this.error = null; this.failures = 0;
        } catch (err) {
          if (err.code === 'reconnect_required' || err.code === 'patient_unavailable') {
            c.needsLogin = true;
            await check(); await this.store.save(c);
          }
          throw err;
        }
      });
    } catch (err) { this.error = err.code || 'storage_unavailable'; this.failures++; }
    this.schedule(this.failures ? Math.min(15 * 60000, 30000 * Math.pow(2, Math.min(this.failures, 5))) : 60000);
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.session) await this.end(this.session, 'CANCEL');
  }
}
module.exports = Manager;
