'use strict';

// Subcommand dispatcher for bin/nightscout.js (D21).
//
// Each subcommand is a module under ./commands, loaded only when it is run,
// so `nightscout version` does not load the server. A command module exports
// run(args, io) and returns (or resolves to) an exit status; `single` returns
// nothing, because the server keeps the process alive.
//
// Hosted roles will arrive as `nightscout serve <role>[,<role>...]`
// (PLAT-SERVE); until then `serve` exits with EX_USAGE and says so.

const fs = require('fs');
const path = require('path');

const EX_USAGE = 64;

// Order is the order `help` lists them in.
const COMMANDS = {
  single: {
    usage: 'single'
    , summary: 'run the Nightscout server as one process (what `npm start` runs)'
    , load: () => require('./commands/single')
  }
  , serve: {
    usage: 'serve <role>[,<role>...]'
    , summary: 'run hosted roles (not yet available)'
    , load: () => require('./commands/serve')
  }
  , diagnose: {
    usage: 'diagnose data [--limit N]'
    , summary: 'read-only, aggregate report on stored records'
    , load: () => require('./commands/diagnose')
  }
  , healthcheck: {
    usage: 'healthcheck [--timeout MS] [--url URL]'
    , summary: 'exit 0 when the server on PORT answers, non-zero otherwise'
    , load: () => require('./commands/healthcheck')
  }
  , version: {
    usage: 'version'
    , summary: 'print the Nightscout version'
    , load: () => require('./commands/version')
  }
  , env: {
    usage: 'env'
    , summary: 'print the effective configuration, secrets redacted'
    , load: () => require('./commands/env')
  }
  , help: {
    usage: 'help'
    , summary: 'print this list'
    , load: () => ({ run: (args, io) => { io.stdout.write(usage()); return 0; } })
  }
};

function usage () {
  const width = Math.max(...Object.values(COMMANDS).map(c => c.usage.length));
  const lines = Object.values(COMMANDS).map(c => '  nightscout ' + c.usage.padEnd(width) + '  ' + c.summary);
  return 'Usage: nightscout <command> [args]\n\nCommands:\n' + lines.join('\n') + '\n\n'
    + 'Any other first argument that names a program (for example `node lib/server/server.js`)\n'
    + 'is run as given, so an image started with an explicit command keeps working.\n';
}

// A first argument that is not a subcommand but names a program: a path, or a
// name found on PATH. This is the docker-entrypoint convention, kept so that
// `docker run <image> node lib/server/server.js` (the old CMD) still works
// under ENTRYPOINT ["node", "bin/nightscout.js"].
function findProgram (name, env) {
  if (!name || name.startsWith('-')) return null;
  if (name.includes('/') || name.includes(path.sep)) {
    return isExecutable(name) ? name : null;
  }
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable (file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Run the program as a child, pass the signals a supervisor sends on to it,
// and exit with its status, so the dispatcher is transparent as PID 1.
function passthrough (program, args) {
  const { spawn } = require('child_process');
  const child = spawn(program, args, { stdio: 'inherit' });
  const forward = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'];
  forward.forEach(sig => process.on(sig, () => child.kill(sig)));
  child.on('error', err => {
    console.error('nightscout: could not run ' + program + ': ' + err.message);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      forward.forEach(sig => process.removeAllListeners(sig));
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code);
  });
}

function settle (result) {
  if (result === undefined) return;
  if (result && typeof result.then === 'function') {
    result.then(settle, err => {
      console.error('nightscout: ' + (err && err.message ? err.message : err));
      process.exitCode = 1;
    });
    return;
  }
  process.exitCode = result;
}

function main (argv, io) {
  io = io || { stdout: process.stdout, stderr: process.stderr, env: process.env };
  const [name, ...args] = argv;

  if (name === undefined || name === '--help' || name === '-h') {
    io.stdout.write(usage());
    process.exitCode = 0;
    return;
  }

  if (Object.prototype.hasOwnProperty.call(COMMANDS, name)) {
    return settle(COMMANDS[name].load().run(args, io));
  }

  const program = findProgram(name, io.env);
  if (program) return passthrough(program, args);

  io.stderr.write('nightscout: unknown command: ' + name + '\n\n' + usage());
  process.exitCode = EX_USAGE;
}

module.exports = { main, usage, COMMANDS, EX_USAGE, findProgram };
