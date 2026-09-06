/*
 * Env-file parsing adapted from env-cmd 10.1.0.
 * MIT License
 * 
 * Copyright (c) 2019 Todd Bluhm
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

'use strict';
const fs = require('node:fs');
const {spawn} = require('node:child_process');

// Keep the existing .env grammar: file values win, # is literal inside a
// value, enclosing quotes are removed and escaped newlines are expanded.
function parseEnv(text) {
  const values = {};
  const lines = text.replace(/^#.*$/gm, '').replace(/^\n/gm, '');
  const pattern = /^(.+?)=(.*)$/gm;
  let match;
  while ((match = pattern.exec(lines))) {
    values[match[1].trim()] = match[2].trim().replace(/(^['"]|['"]$)/g, '').replace(/\\n/g, '\n');
  }
  return values;
}

if (require.main === module) {
  const [file, ...args] = process.argv.slice(2);
  if (!file || !args.length) throw new Error('Usage: node bin/with-env.js FILE [NODE_OPTIONS] SCRIPT [ARGS]');
  const env = {...process.env, ...parseEnv(fs.readFileSync(file, 'utf8'))};
  const child = spawn(process.execPath, args, {env, stdio: 'inherit'});
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let requestedSignal;
  const handlers = signals.map(signal => () => {requestedSignal = signal; child.kill(signal);});
  const terminate = () => child.kill('SIGTERM');
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  process.on('exit', terminate);
  const cleanup = () => {
    signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
    process.removeListener('exit', terminate);
  };
  child.once('error', error => {cleanup(); console.error(error.message); process.exitCode = 1;});
  child.once('exit', (code, signal) => {
    cleanup();
    if (requestedSignal || signal) process.kill(process.pid, requestedSignal || signal);
    else process.exitCode = code;
  });
}
module.exports = parseEnv;
