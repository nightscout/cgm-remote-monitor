'use strict';

const { performance } = require('node:perf_hooks');

// Per-attempt observations for the dedicated pgstream receiver. Never log the
// event, tenant, request headers, callback result or exception text.
function create({ write = line => process.stdout.write(line), now = () => performance.now(),
  wall = Date.now, canWrite = () => !process.stdout.writableNeedDrain } = {}) {
  let sequence = 0, bucket, written = 0, dropped = 0;
  function emit(fields) {
    try {
      const at = wall(), second = Math.floor(at / 1000);
      if (second !== bucket) { bucket = second; written = 0; }
      if (written >= 100 || !canWrite()) { dropped++; return; }
      written++;
      write('PGSTREAM_RECEIVER_TRACE ' + JSON.stringify({ at, ...fields, dropped }) + '\n');
      dropped = 0;
    } catch { dropped++; }
  }
  function start(response) {
    const request = ++sequence;
    const started = now();
    let phase = 'body';
    let shape;
    function record(event, status) {
      emit({ request, event, phase, elapsedMs: Math.round(now() - started), ...shape, status });
    }
    response.once('finish', () => record('response-finished', response.statusCode));
    response.once('close', () => {
      if (!response.writableFinished) record('closed-before-finish');
    });
    record('received');
    return {
      mark(next) { phase = next; record('stage'); },
      parsed(event, bytes) {
        const transaction = Array.isArray(event?.Transaction) ? event.Transaction : undefined;
        const end = transaction?.at(-1);
        const position = end?.action === 'C' && typeof end.nextlsn === 'string'
          && /^[0-9a-f]{1,8}\/[0-9a-f]{1,8}$/i.test(end.nextlsn) ? end.nextlsn : undefined;
        const hasSchemaMarker = transaction
          ? transaction.some(frame => frame?.action === 'M' && frame?.prefix === 'pgstream.ddl')
          : event?.Data?.action === 'M' && event?.Data?.prefix === 'pgstream.ddl';
        shape = { bytes, format: transaction ? (event.Slice ? 'slice' : 'full') : 'single',
          rows: transaction ? Math.max(0, transaction.length - 2) : undefined, hasSchemaMarker, position };
        phase = 'validate';
        record('stage');
      },
      refused() { record('refused'); }
    };
  }
  return { listening: () => emit({ event: 'listening' }), start };
}

module.exports = { create };
