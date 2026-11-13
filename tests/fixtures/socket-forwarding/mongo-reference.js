'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');

module.exports = async function reference ({ connectionString, database }) {
  const child = fork(path.join(__dirname, 'mongo-reference-child.js'), [], {
    silent: true, env: { ...process.env, NS_SOCKET_MONGO_REFERENCE: JSON.stringify({ connectionString, database }) }
  });
  let diagnostics = '', sequence = 0, exit;
  const redact = text => text.split(connectionString).join('[private Mongo connection]')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'")]+/g, '[private Mongo connection]');
  function capture (stream, destination, prefix, isError) {
    let pending = '';
    function emit (line) {
      const text = redact(line);
      if (isError) diagnostics += text;
      destination.write(prefix + text);
    }
    stream.on('data', data => {
      pending += data.toString();
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) { emit(pending.slice(0, newline + 1)); pending = pending.slice(newline + 1); }
    });
    stream.on('end', () => { if (pending) emit(pending); });
  }
  capture(child.stdout, process.stdout, '[single-reference] ', false);
  capture(child.stderr, process.stderr, '[single-reference error] ', true);
  const ended = new Promise(resolve => child.once('close', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  function waitFor (type, id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Single reference IPC timeout: ' + type)), 10000);
      const message = value => { if (value.type === type && value.id === id) finish(null, value); };
      const failed = error => finish(error);
      const stopped = () => finish(new Error('Single reference exited before ' + type));
      function finish (error, value) {
        clearTimeout(timer); child.off('message', message); child.off('error', failed); child.off('exit', stopped);
        if (error) reject(error); else resolve(value);
      }
      child.on('message', message); child.once('error', failed); child.once('exit', stopped);
    });
  }
  async function command (type, response) {
    const id = ++sequence, result = waitFor(response, id); child.send({ type, id }); return result;
  }
  async function close () {
    try { if (!exit) await command('close', 'closed'); }
    finally {
      if (!exit) {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await ended; clearTimeout(timer);
      }
      let absent = false;
      try { process.kill(child.pid, 0); } catch (error) { absent = error.code === 'ESRCH'; }
      console.log('Single reference child cleanup: ' + JSON.stringify({ pid: child.pid, ...exit, absent }));
      assert.equal(absent, true, 'exact owned single-reference child must be absent');
      assert.equal(exit.code, 0, 'single-reference child must close cleanly');
    }
  }
  try {
    const ready = await waitFor('ready', undefined);
    assert.equal(ready.pid, child.pid); assert.equal(ready.mode, 'single');
    assert(Number.isInteger(ready.port) && ready.port > 0);
    console.log('Single reference child started: ' + JSON.stringify(ready));
    return { port: ready.port, pid: child.pid, reset: () => command('reset', 'reset-done'), close,
      assertHealthy () { assert.equal(diagnostics, '', 'single reference must not hide a handler/storage failure'); } };
  } catch (error) { await close(); throw error; }
};
