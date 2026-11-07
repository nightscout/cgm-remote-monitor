'use strict';
// Bounded observational fixture only: no client/provider behavior or timeout changes.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const STAGES = Object.freeze(['navigation', 'initial-client', 'empty-sgvs', 'urgent-event', 'urgent-ui']);
const NAMES = new Set(['Error', 'TimeoutError', 'TypeError', 'ReferenceError', 'SyntaxError', 'AssertionError', 'RangeError']);
const NET = new Set(['ERR_ABORTED', 'ERR_FAILED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED',
  'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT', 'ERR_BLOCKED_BY_CLIENT', 'ERR_EMPTY_RESPONSE', 'ERR_HTTP_RESPONSE_CODE_FAILURE', 'ERR_ADDRESS_UNREACHABLE']);
const digest = value => createHash('sha256').update(String(value).slice(0, 4096)).digest('hex');
function errorInfo (error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const code = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  return { name: NAMES.has(error?.name) ? error.name : 'OtherError', messageHash: digest(message), ...(NET.has(code) ? { networkCode: code } : {}) };
}
function network (url, hosts) {
  try {
    const parsed = new URL(url), pathname = parsed.pathname;
    return { knownHost: hosts.includes(parsed.hostname), route: pathname === '/' ? 'page' : /^\/socket\.io(?:\/|$)/.test(pathname) ? 'socket.io'
      : /^\/api(?:\/|$)/.test(pathname) ? 'api' : /^\/(?:js|css|img|images|font|static|bundle)(?:\/|\.)/.test(pathname) ? 'asset' : 'other',
    eio: ['3', '4'].includes(parsed.searchParams.get('EIO')) ? Number(parsed.searchParams.get('EIO')) : null,
    transport: ['polling', 'websocket'].includes(parsed.searchParams.get('transport')) ? parsed.searchParams.get('transport') : null };
  } catch { return { knownHost: false, route: 'invalid', eio: null, transport: null }; }
}
// This function runs in the real page. Never reads credentials, DOM text, local
// storage, socket URIs or event payloads; it returns only selected state scalars.
function pageSnapshot (expectedMgdl) {
  const client = window.Nightscout?.client;
  const socket = value => ({ present: !!value, connected: value?.connected === true,
    engineTransport: ['polling', 'websocket'].includes(value?.io?.engine?.transport?.name) ? value.io.engine.transport.name : null,
    engineReadyState: ['opening', 'open', 'closing', 'closed'].includes(value?.io?.engine?.readyState) ? value.io.engine.readyState : null });
  const sgvs = client?.ddata?.sgvs;
  return { nightscoutType: typeof window.Nightscout, clientType: typeof client, documentReadyState: document.readyState,
    main: socket(client?.socket), alarm: socket(client?.alarmSocket), sgvCount: Array.isArray(sgvs) ? sgvs.length : null,
    hasExpectedSynthetic123: Array.isArray(sgvs) && sgvs.some(row => row.mgdl === expectedMgdl),
    urgentUi: !!document.querySelector('.container.alarming.urgent'),
    eventNames: Array.isArray(window.__rtObservedAlarmEvents) ? window.__rtObservedAlarmEvents.slice(-16).map(row => row.event).filter(name => ['urgent_alarm', 'alarm', 'announcement'].includes(name)) : [] };
}
function safeSnapshot (value) {
  const types = ['undefined', 'object', 'function', 'boolean', 'number', 'string', 'symbol', 'bigint'];
  const socket = item => ({ present: item?.present === true, connected: item?.connected === true,
    engineTransport: ['polling', 'websocket'].includes(item?.engineTransport) ? item.engineTransport : null,
    engineReadyState: ['opening', 'open', 'closing', 'closed'].includes(item?.engineReadyState) ? item.engineReadyState : null });
  return { nightscoutType: types.includes(value?.nightscoutType) ? value.nightscoutType : 'undefined',
    clientType: types.includes(value?.clientType) ? value.clientType : 'undefined',
    documentReadyState: ['loading', 'interactive', 'complete'].includes(value?.documentReadyState) ? value.documentReadyState : null,
    main: socket(value?.main), alarm: socket(value?.alarm), sgvCount: Number.isSafeInteger(value?.sgvCount) && value.sgvCount >= 0 ? value.sgvCount : null,
    hasExpectedSynthetic123: value?.hasExpectedSynthetic123 === true, urgentUi: value?.urgentUi === true,
    eventNames: Array.isArray(value?.eventNames) ? value.eventNames.filter(name => ['urgent_alarm', 'alarm', 'announcement'].includes(name)).slice(-16) : [] };
}
function create ({ write, hosts, runtime, expectedMgdl }) {
  assert.equal(typeof write, 'function'); assert(Array.isArray(hosts)); assert.equal(expectedMgdl, 123, 'Diagnostic probe must name the admitted synthetic SGV');
  assert(runtime && runtime.browser === 'chromium' && /^[a-f0-9]{64}$/.test(runtime.sha256) && typeof runtime.executablePath === 'string' && typeof runtime.version === 'string' && runtime.version.length <= 64 && runtime.version.split('.').length >= 2 && runtime.version.split('.').length <= 5 && runtime.version.split('.').every(part => /^[0-9]+$/.test(part)));
  const state = { version: 1, classification: 'observational browser fixture; no payloads or credentials',
    browserRuntime: Object.fromEntries(['browser', 'executablePath', 'sha256', 'version', 'dev', 'ino', 'mode'].map(key => [key, runtime[key]])),
    activeStage: null, status: 'launched', stages: [], diagnostics: [], droppedDiagnostics: 0 };
  const flush = () => { const text = JSON.stringify(state); assert(Buffer.byteLength(text) <= 65536, 'BROWSER_DIAGNOSTIC_BOUND'); write(text + '\n'); };
  flush();
  function event (item) { if (state.diagnostics.length < 128) state.diagnostics.push(item); else state.droppedDiagnostics++; flush(); }
  function attach (page) {
    const listeners = [];
    function on (name, fn, emitter = page) { emitter.on(name, fn); listeners.push([emitter, name, fn]); }
    on('console', message => event({ kind: 'console', type: ['log', 'debug', 'info', 'error', 'warning', 'warn', 'assert'].includes(message.type()) ? message.type() : 'other', messageHash: digest(message.text()) }));
    on('pageerror', error => event({ kind: 'pageerror', error: errorInfo(error) }));
    on('requestfailed', request => event({ kind: 'requestfailed', ...network(request.url(), hosts), error: errorInfo({ name: 'Error', message: request.failure()?.errorText || '' }) }));
    on('response', response => event({ kind: 'response', ...network(response.url(), hosts), status: Number.isInteger(response.status()) && response.status() >= 100 && response.status() <= 599 ? response.status() : null }));
    on('websocket', socket => { const selected = network(socket.url(), hosts); event({ kind: 'websocket-open', ...selected }); on('close', () => event({ kind: 'websocket-close', ...selected }), socket); });
    return () => { for (const [emitter, name, fn] of listeners) emitter.off(name, fn); };
  }
  async function capture (stage, edge, page, error) {
    assert(STAGES.includes(stage)); assert(['before', 'after', 'error'].includes(edge));
    const row = { stage, edge }; if (error) row.error = errorInfo(error);
    // Flush before evaluate too: a destroyed/unresponsive page cannot erase
    // the exact consumed stage. Snapshot refusal is distinct from wait failure.
    state.activeStage = stage; state.status = edge; state.stages.push(row); assert(state.stages.length <= 24); flush();
    if (page) try { row.snapshot = safeSnapshot(await page.evaluate(pageSnapshot, expectedMgdl)); }
    catch (failure) { row.snapshotError = errorInfo(failure); }
    flush();
  }
  async function wait (stage, page, action) {
    await capture(stage, 'before', page);
    try { const value = await action(); await capture(stage, 'after', page); return value; }
    catch (error) { await capture(stage, 'error', page, error); throw error; }
  }
  async function failure (error, page) { if (state.status !== 'error') await capture(state.activeStage || 'navigation', 'error', page, error); }
  function complete () { state.status = 'complete'; flush(); }
  return { attach, wait, failure, complete };
}
module.exports = { create, STAGES, errorInfo, network, pageSnapshot, safeSnapshot };
