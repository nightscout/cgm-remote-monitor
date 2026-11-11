'use strict';

// `nightscout admin provision`: a thin client of the admin role's tenant
// provisioning REST resource (lib/tenant-registry/rest.js; decisions
// provisioning-split and operator-rest-api). It holds no database or Vault
// credential; it reaches the admin listener as any operator client does.
//
//   nightscout admin provision --id <uuid> --host <host> [--host <host>...]
//                              [--internal-host <host>] [--ref <label>]
//   nightscout admin provision --seed <file.json|file.csv> [--batch N]
//   common: [--url http://<private address>:<port> | --socket <path>]
//           [--secrets-out <file>] [--timeout MS]
//
// The listener defaults to http://ADMIN_HOSTNAME:ADMIN_PORT. Seeds go out in
// batches of at most 100 (the API bound). One line per tenant on stdout:
//   <ref|-> <id> <created|existing|refused> [code]
// With --secrets-out, each 'created' tenant's root secret is requested and
// appended to that file (mode 0600, JSON lines {ref,id,rootSecret}); it is never
// written to stdout, stderr or a log. Re-running is safe: provisioned tenants
// answer 'existing' and no secret is issued again.
//
// Seed schema (one for both formats):
//   id            canonical lower-case UUID (required)
//   hosts         public aliases; JSON array, CSV `hosts` column separated by ';'
//   internalHost  canonical internal name (CSV column `internal_host`)
//   ref           optional label ^[A-Za-z0-9_.-]{1,64}$, echoed in results
// JSON: { "version": 1, "tenants": [ { ... }, ... ] }
// CSV:  a header row naming `id`, `hosts` and optionally `internal_host`, `ref`;
//       no quoting; one tenant per line.
//
// Exit: 0 every tenant created or existing; 1 any refused; 64 usage or seed
// invalid; 69 the admin listener unavailable or answered unexpectedly.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const EX_USAGE = 64, EX_UNAVAILABLE = 69;
const MAX_BATCH = 100, MAX_SEED = 100000;
const usageError = message => Object.assign(new Error(message), { usage: true });

function parseArgs (args) {
  const out = { hosts: [] };
  const value = (i, name) => { if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw usageError(name + ' needs a value'); return args[i + 1]; };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--id': out.id = value(i, arg); i++; break;
      case '--host': out.hosts.push(value(i, arg)); i++; break;
      case '--internal-host': out.internalHost = value(i, arg); i++; break;
      case '--ref': out.ref = value(i, arg); i++; break;
      case '--seed': out.seed = value(i, arg); i++; break;
      case '--batch': out.batch = Number(value(i, arg)); i++; break;
      case '--url': out.url = value(i, arg); i++; break;
      case '--socket': out.socket = value(i, arg); i++; break;
      case '--secrets-out': out.secretsOut = value(i, arg); i++; break;
      case '--timeout': out.timeout = Number(value(i, arg)); i++; break;
      default: throw usageError('unknown argument ' + JSON.stringify(arg));
    }
  }
  if (!!out.seed === !!out.id) throw usageError('give either --seed or --id');
  if (out.seed && (out.hosts.length || out.internalHost || out.ref)) throw usageError('--host, --internal-host and --ref apply to --id only');
  if (out.batch !== undefined && (!Number.isSafeInteger(out.batch) || out.batch < 1 || out.batch > MAX_BATCH)) throw usageError('--batch must be 1..' + MAX_BATCH);
  if (out.timeout !== undefined && (!Number.isSafeInteger(out.timeout) || out.timeout < 1 || out.timeout > 600000)) throw usageError('--timeout must be 1..600000 ms');
  if (out.url && out.socket) throw usageError('give --url or --socket, not both');
  if (out.socket && !path.isAbsolute(out.socket)) throw usageError('--socket must be an absolute path');
  if (out.secretsOut && !path.isAbsolute(out.secretsOut)) throw usageError('--secrets-out must be an absolute path');
  return out;
}

function seedRows (file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw usageError('cannot read seed file'); }
  let rows;
  if (/\.json$/i.test(file)) {
    let doc; try { doc = JSON.parse(text); } catch { throw usageError('seed JSON is not valid'); }
    if (!doc || doc.version !== 1 || !Array.isArray(doc.tenants) || Object.keys(doc).some(key => !['version', 'tenants'].includes(key))) throw usageError('seed JSON must be { "version": 1, "tenants": [...] }');
    rows = doc.tenants;
  } else if (/\.csv$/i.test(file)) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (!lines.length || /["']/.test(text)) throw usageError('seed CSV needs a header row and no quoting');
    const header = lines[0].split(',').map(cell => cell.trim());
    const allowed = ['id', 'hosts', 'internal_host', 'ref'];
    if (!header.includes('id') || header.some(cell => !allowed.includes(cell)) || new Set(header).size !== header.length) throw usageError('seed CSV header must name id and only hosts, internal_host, ref');
    rows = lines.slice(1).map(line => {
      const cells = line.split(',').map(cell => cell.trim());
      if (cells.length !== header.length) throw usageError('seed CSV row has the wrong number of cells');
      const cell = Object.fromEntries(header.map((name, i) => [name, cells[i]]));
      return { id: cell.id, ...(cell.hosts ? { hosts: cell.hosts.split(';').map(host => host.trim()).filter(Boolean) } : {}),
        ...(cell.internal_host ? { internalHost: cell.internal_host } : {}), ...(cell.ref ? { ref: cell.ref } : {}) };
    });
  } else throw usageError('seed file must end in .json or .csv');
  if (!rows.length || rows.length > MAX_SEED) throw usageError('seed must list 1..' + MAX_SEED + ' tenants');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id', 'hosts', 'internalHost', 'ref'].includes(key))) {
      throw usageError('seed tenant fields are id, hosts, internalHost, ref');
    }
  }
  return rows;
}

function endpoint (options, env) {
  if (options.socket) return { socketPath: options.socket };
  const raw = options.url || 'http://' + (env.ADMIN_HOSTNAME || '127.0.0.1') + ':' + (env.ADMIN_PORT || '');
  let url; try { url = new URL(raw); } catch { throw usageError('admin listener address is invalid; give --url or set ADMIN_HOSTNAME/ADMIN_PORT'); }
  if (url.protocol !== 'http:' || !url.port || url.pathname !== '/' || url.search || url.username) throw usageError('admin listener address must be http://<host>:<port>');
  return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) };
}

function call (target, method, route, body, timeout) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ ...target, method, path: route, agent: false, timeout,
      headers: { accept: 'application/json', ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 16777216) req.destroy(); else chunks.push(chunk); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { reject(new Error('admin listener answered with an unreadable body')); }
      });
      res.on('error', () => reject(new Error('admin listener connection failed')));
    });
    req.on('timeout', () => req.destroy(new Error('admin listener timed out')));
    req.on('error', error => reject(new Error(error.message === 'admin listener timed out' ? error.message : 'admin listener unavailable')));
    req.end(bytes || undefined);
  });
}

function secretsSink (file) {
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error();
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    throw usageError('--secrets-out must be a regular file of this user with mode 0600');
  }
  return { write (row) { fs.writeSync(fd, JSON.stringify(row) + '\n'); }, close () { fs.closeSync(fd); } };
}

async function provision (args, io) {
  const options = parseArgs(args);
  const target = endpoint(options, io.env || process.env);
  const timeout = options.timeout || 120000;
  const issue = !!options.secretsOut;
  const rows = options.seed ? seedRows(options.seed)
    : [{ id: options.id, ...(options.hosts.length ? { hosts: options.hosts } : {}), ...(options.internalHost ? { internalHost: options.internalHost } : {}),
      ...(options.ref ? { ref: options.ref } : {}) }];
  const sink = secretsSink(options.secretsOut);
  const size = options.batch || MAX_BATCH;
  let refused = 0;
  const report = result => {
    if (result.rootSecret !== undefined) {
      if (sink) sink.write({ ...(result.ref ? { ref: result.ref } : {}), id: result.id, rootSecret: result.rootSecret });
    }
    if (result.outcome === 'refused') refused++;
    io.stdout.write([result.ref || '-', result.id === null || result.id === undefined ? '-' : result.id, result.outcome, ...(result.code ? [result.code] : [])].join(' ') + '\n');
  };
  try {
    for (let start = 0; start < rows.length; start += size) {
      const batch = rows.slice(start, start + size).map(row => issue ? { ...row, issueRootSecret: true } : row);
      const answer = await call(target, 'POST', '/v1/tenants/batch', { tenants: batch }, timeout);
      if (answer.status === 200 && Array.isArray(answer.body?.results) && answer.body.results.length === batch.length) {
        answer.body.results.forEach(report);
        continue;
      }
      const code = typeof answer.body?.code === 'string' ? answer.body.code : 'HTTP_' + answer.status;
      if (answer.status === 422 || answer.status === 413) {
        // The whole batch was refused before any work (duplicates, bounds).
        for (const row of batch) report({ id: typeof row.id === 'string' ? row.id : null, ref: row.ref, outcome: 'refused', code });
        continue;
      }
      throw new Error('admin listener answered ' + answer.status + ' ' + code);
    }
  } finally { if (sink) sink.close(); }
  return refused ? 1 : 0;
}

async function run (args, io) {
  const [verb, ...rest] = args;
  try {
    if (verb === 'provision') return await provision(rest, io);
    throw usageError('usage: nightscout admin provision (--id <uuid> --host <host>... | --seed <file>) [--url URL | --socket PATH] [--secrets-out FILE] [--batch N]');
  } catch (error) {
    // Never echo a response body or an argument value: either could carry a secret.
    io.stderr.write('nightscout admin: ' + (error.usage ? error.message : (error.message || 'failed').replace(/[^\x20-\x7e]/g, '')) + '\n');
    return error.usage ? EX_USAGE : EX_UNAVAILABLE;
  }
}

module.exports = { run, parseArgs, seedRows, MAX_BATCH };
