'use strict';

// Subcommand dispatcher for bin/nightscout.js (D21).
//
// Each subcommand is a module under ./commands, loaded only when it is run,
// so `nightscout version` does not load the server. A command module exports
// run(args, io) and returns (or resolves to) an exit status; `single` returns
// nothing, because the server keeps the process alive.
//
// Hosted roles are `nightscout serve <role>[,<role>...]` (PLAT-SERVE); `api`
// can be served, and the other roles exit with EX_USAGE and say so.

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
    , summary: 'run hosted roles, each on its own listener (api; the others are not yet available)'
    , load: () => require('./commands/serve')
  }
  , diagnose: {
    usage: 'diagnose data [--limit N]'
    , summary: 'read-only, aggregate report on stored records'
    , load: () => require('./commands/diagnose')
  }
  , healthcheck: {
    usage: 'healthcheck [--timeout MS] [--url URL | --role ROLE]'
    , summary: 'exit 0 when the server on PORT (or ROLE\'s listener) answers, non-zero otherwise'
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
    + 'Any other first argument that names a program or a script (for example\n'
    + '`node lib/server/server.js`, or `lib/server/server.js`, which is run with node) is run\n'
    + 'as given, so an image started with an explicit command keeps working.\n';
}

// A first argument that is not a subcommand is treated as the node image's
// docker-entrypoint.sh treats it (the previous image's entrypoint), so an
// image run with an explicit command keeps working under
// ENTRYPOINT ["node", "/opt/app/bin/nightscout.js"]:
//   - an option (`--inspect lib/server/server.js`) or a file that is not
//     executable (`lib/server/server.js`) is run with node;
//   - an executable file or a program on PATH (`node lib/server/server.js`,
//     `sh`) is run as given.
// Anything else is an unknown subcommand. Returns [program, args] or null.
function resolveProgram (argv, env) {
  const [name, ...args] = argv;
  if (!name) return null;
  if (name.startsWith('-')) return [process.execPath, argv];
  if (isFile(name)) return isExecutable(name) ? [name, args] : [process.execPath, argv];
  if (name.includes('/') || name.includes(path.sep)) return null;
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate) && isExecutable(candidate)) return [candidate, args];
    }
  }
  return null;
}

function isFile (file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable (file) {
  try {
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
      // As PID 1 the kernel ignores that signal; exit as a shell reports it.
      setImmediate(() => process.exit(128 + (require('os').constants.signals[signal] || 0)));
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

  const program = resolveProgram(argv, io.env);
  if (program) return passthrough(program[0], program[1]);

  io.stderr.write('nightscout: unknown command: ' + name + '\n\n' + usage());
  process.exitCode = EX_USAGE;
}

module.exports = { main, usage, COMMANDS, EX_USAGE, resolveProgram };
