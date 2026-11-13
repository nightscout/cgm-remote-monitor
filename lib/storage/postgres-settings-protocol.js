'use strict';

// Component-owned actual-driver protocol observations for the display pool.
// These records prove current protocol state, never controller admission.
const { Client } = require('pg');
const records = new WeakMap();
const refusal = () => Object.assign(new Error('POSTGRES_SETTINGS_PROTOCOL_REQUIRED'), { code: 'POSTGRES_SETTINGS_PROTOCOL_REQUIRED' });
class SettingsClient extends Client {
  constructor (options) {
    super(options);
    const row = { ready: false, status: null, failed: false, closed: false, stream: null };
    records.set(this, row);
    this.once('connect', () => {
      row.stream = this.connection.stream;
      row.stream.on('error', () => { row.failed = true; row.ready = false; });
      row.stream.on('end', () => { row.closed = true; row.ready = false; });
      row.stream.on('close', () => { row.closed = true; row.ready = false; });
    });
    this.on('error', () => { row.failed = true; row.ready = false; });
    this.once('end', () => { row.closed = true; row.ready = false; });
  }
  query (...args) {
    const row = records.get(this);
    row.ready = false; row.status = null;
    return super.query(...args);
  }
  _handleReadyForQuery (message) {
    const row = records.get(this);
    row.status = ['I', 'T', 'E'].includes(message?.status) ? message.status : null;
    row.ready = row.status !== null;
    return super._handleReadyForQuery(message);
  }
  _handleErrorMessage (message) {
    const row = records.get(this);
    row.ready = false; row.status = null;
    return super._handleErrorMessage(message);
  }
}
function assertReady (client, statuses) {
  const row = records.get(client);
  if (!row || !(client instanceof Client) || !row.ready || !statuses.includes(row.status) ||
      row.failed || row.closed || row.stream !== client.connection?.stream || !row.stream || row.stream.destroyed || row.stream.writable !== true ||
      !client._connected || client._ending || client._connectionError || !client._queryable || client.readyForQuery !== true || client.pipeline === true ||
      client._getActiveQuery() || !Array.isArray(client._queryQueue) || client._queryQueue.length ||
      !Array.isArray(client._sentQueryQueue) || client._sentQueryQueue.length) throw refusal();
}
module.exports = Object.freeze({ Client: SettingsClient,
  assertTransaction: client => assertReady(client, ['T']), assertRollback: client => assertReady(client, ['T', 'E']), assertUnlock: client => assertReady(client, ['I']) });
