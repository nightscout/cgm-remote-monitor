'use strict';

const assert = require('node:assert/strict');
const { colorsEnabled, logPrefix } = require('../lib/server/log-colors');

// A stdout that shows colour, and one that does not: a terminal, and the pipe
// a log file or syslog sits behind.
const terminal = { isTTY: true, getColorDepth: () => 8 };
const pipe = { isTTY: false, getColorDepth: () => 1 };

function plainTerminal () {
  return { isTTY: true, getColorDepth: () => 1 };
}

describe('log colours', function () {
  it('writes the prefix in colour on a terminal', function () {
    assert.equal(colorsEnabled(terminal, {}), true);
    assert.equal(logPrefix('WS: ', 'green', { stream: terminal, env: {} }), '\x1B[32mWS: \x1B[0m');
    assert.equal(logPrefix('DEDUPE: ', 'magenta', { stream: terminal, env: {} }), '\x1B[35mDEDUPE: \x1B[0m');
  });

  it('writes the prefix plain when stdout is a pipe (#7275)', function () {
    assert.equal(colorsEnabled(pipe, {}), false);
    assert.equal(logPrefix('WS: ', 'green', { stream: pipe, env: {} }), 'WS: ');
    assert.equal(logPrefix('STORAGE SOCKET: ', 'magenta', { stream: pipe, env: {} }), 'STORAGE SOCKET: ');
  });

  it('writes the prefix plain on a terminal of one colour depth', function () {
    assert.equal(colorsEnabled(plainTerminal(), {}), false);
  });

  it('honours NO_COLOR on a terminal that shows colour', function () {
    assert.equal(colorsEnabled(terminal, { NO_COLOR: '1' }), false);
    assert.equal(logPrefix('WS: ', 'green', { stream: terminal, env: { NO_COLOR: '1' } }), 'WS: ');
  });

  it('keeps the colour for an empty NO_COLOR, which is not set', function () {
    assert.equal(colorsEnabled(terminal, { NO_COLOR: '' }), true);
  });

  it('honours NODE_DISABLE_COLORS on a terminal that shows colour', function () {
    assert.equal(colorsEnabled(terminal, { NODE_DISABLE_COLORS: '1' }), false);
    assert.equal(colorsEnabled(terminal, { NODE_DISABLE_COLORS: 'true' }), false);
  });

  it('keeps the colour for NODE_DISABLE_COLORS=0, which Node reads as off', function () {
    assert.equal(colorsEnabled(terminal, { NODE_DISABLE_COLORS: '0' }), true);
  });

  it('honours FORCE_COLOR on a pipe and above NO_COLOR', function () {
    assert.equal(colorsEnabled(pipe, { FORCE_COLOR: '1' }), true);
    assert.equal(logPrefix('WS: ', 'green', { stream: pipe, env: { FORCE_COLOR: '1' } }), '\x1B[32mWS: \x1B[0m');
    assert.equal(colorsEnabled(terminal, { FORCE_COLOR: '0' }), false);
    assert.equal(colorsEnabled(pipe, { FORCE_COLOR: '1', NO_COLOR: '1' }), true);
  });

  it('writes a label with no colour named plain', function () {
    assert.equal(logPrefix('WS: ', 'chartreuse', { stream: terminal, env: {} }), 'WS: ');
  });

  it('writes plain when the stream cannot report its colour depth', function () {
    const broken = { isTTY: true, getColorDepth: () => { throw new Error('closed'); } };
    assert.equal(colorsEnabled(broken, {}), false);
  });

  it('defaults to stdout and process.env', function () {
    const coloured = colorsEnabled(process.stdout, process.env);
    assert.equal(colorsEnabled(undefined, {}), coloured);
    assert.equal(logPrefix('WS: ', 'green'), coloured ? '\x1B[32mWS: \x1B[0m' : 'WS: ');
  });
});
