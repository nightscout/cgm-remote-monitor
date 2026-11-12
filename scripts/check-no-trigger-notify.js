#!/usr/bin/env node
'use strict';

// Decision D6: a change notification is emitted by the replication-slot reader
// only, never from a write trigger (EXP-MT-059: writer-emitted notifications
// fill the queue under a wedged listener and put the queue lock in every data
// transaction). This gate reads every SQL definition the repository ships and
// fails when a trigger function, or a function a trigger function calls, or a
// rewrite rule, contains NOTIFY or pg_notify.
//
//   node scripts/check-no-trigger-notify.js            scan the shipped tree
//   node scripts/check-no-trigger-notify.js <file...>  scan the named files
//
// It fails closed: a trigger function whose body it cannot extract is a
// finding, and a scan that finds no trigger function at all fails (the tree
// ships several; zero means the scanner went blind).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCOPE = ['lib', 'migrations', 'deploy', 'tools', 'bin', 'scripts'];
const NOTIFIES = /\bNOTIFY\b|\bpg_notify\s*\(/i;
const bare = name => name.replace(/"/g, '').split('.').pop().toLowerCase();

// SQL text of a file: every string of a JSON catalogue, or the raw text of
// any other file (SQL in JavaScript string literals reads the same way).
function sqlText (file, text) {
  if (!file.endsWith('.json')) return text.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  const out = [];
  const visit = value => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  try { visit(JSON.parse(text)); } catch { return text; }
  return out.join('\n;\n');
}

const dedupe = list => [...new Map(list.map(f => [f.file + ' ' + f.reason + ' ' + f.name, f])).values()];
function scan (sources) {
  const functions = new Map(); // bare name -> [{ file, trigger, body }]
  const triggered = new Map(); // bare name -> [file] (named by CREATE TRIGGER / EVENT TRIGGER)
  const findings = [], calls = [];
  let bodies = 0;
  for (const { file, text } of sources) {
    const sql = sqlText(file, text);
    const fn = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)\s*\(/gi;
    let m;
    while ((m = fn.exec(sql))) {
      const rest = sql.slice(m.index, m.index + 200000);
      const header = /^[\s\S]*?\bAS\s+(\$[A-Za-z_0-9]*\$|')/i.exec(rest);
      const trigger = /RETURNS\s+(?:event_)?trigger\b/i.test(header ? header[0] : rest.slice(0, 2000));
      let body = null;
      if (header && header[1] !== '\'') {
        const start = header[0].length, end = rest.indexOf(header[1], start);
        if (end >= 0) body = rest.slice(start, end);
      } else if (header) {
        const end = /(?:[^']|'')*'/.exec(rest.slice(header[0].length));
        if (end) body = end[0];
      }
      const name = bare(m[1]);
      if (!functions.has(name)) functions.set(name, []);
      functions.get(name).push({ file, trigger, body });
      if (trigger && body === null) findings.push({ file, name, reason: 'TRIGGER_FUNCTION_BODY_UNREADABLE' });
    }
    const trg = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+|EVENT\s+)?TRIGGER\b[\s\S]{0,4000}?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi;
    while ((m = trg.exec(sql))) {
      const name = bare(m[1]);
      if (!triggered.has(name)) triggered.set(name, []);
      triggered.get(name).push(file);
    }
    // Name-independent pass: every RETURNS trigger body, whatever builds the
    // function's name (a JavaScript expression or template is not a name).
    const returns = /RETURNS\s+(?:event_)?trigger\b/gi;
    while ((m = returns.exec(sql))) {
      bodies++;
      const rest = sql.slice(m.index, m.index + 200000);
      const as = /^[\s\S]{0,2000}?\bAS\s+(\$[A-Za-z_0-9]*\$)/i.exec(rest);
      const end = as ? rest.indexOf(as[1], as[0].length) : -1;
      if (end < 0) { findings.push({ file, name: 'trigger@' + m.index, reason: 'TRIGGER_FUNCTION_BODY_UNREADABLE' }); continue; }
      const body = rest.slice(as[0].length, end);
      if (NOTIFIES.test(body)) findings.push({ file, name: 'trigger@' + m.index, reason: 'TRIGGER_EMITS_NOTIFY' });
      else for (const call of body.matchAll(/([A-Za-z_][\w$]*)\s*\(/g)) calls.push({ file, at: m.index, name: call[1].toLowerCase() });
    }
    const rule = /CREATE\s+(?:OR\s+REPLACE\s+)?RULE\b[\s\S]*?(?:;|$)/gi;
    while ((m = rule.exec(sql))) if (NOTIFIES.test(m[0])) findings.push({ file, name: 'rule', reason: 'RULE_NOTIFIES' });
  }
  // Notifiers: functions whose body notifies, closed over calls (a function
  // calling a notifier notifies).
  const notifiers = new Set();
  for (const [name, defs] of functions) if (defs.some(d => d.body && NOTIFIES.test(d.body))) notifiers.add(name);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, defs] of functions) {
      if (notifiers.has(name)) continue;
      if (defs.some(d => d.body && [...notifiers].some(n => new RegExp('\\b' + n.replace(/[$]/g, '\\$') + '\\s*\\(', 'i').test(d.body)))) { notifiers.add(name); grew = true; }
    }
  }
  // A trigger body (name-independent pass) calling a notifying function.
  for (const call of calls) if (notifiers.has(call.name)) findings.push({ file: call.file, name: 'trigger@' + call.at + '->' + call.name, reason: 'TRIGGER_EMITS_NOTIFY' });
  const triggerFunctions = new Set([...triggered.keys()]);
  for (const [name, defs] of functions) if (defs.some(d => d.trigger)) triggerFunctions.add(name);
  for (const name of triggerFunctions) {
    if (notifiers.has(name)) findings.push({ file: (functions.get(name) || [{ file: triggered.get(name)[0] }])[0].file, name, reason: 'TRIGGER_EMITS_NOTIFY' });
    else if (!functions.has(name)) {
      // A trigger on a function this tree does not define (built-ins such as
      // suppress_redundant_updates_trigger) cannot be read here.
      if (!/^(suppress_redundant_updates_trigger|tsvector_update_trigger(_column)?|lo_manage|unique_key_recheck)$/.test(name)) findings.push({ file: triggered.get(name)[0], name, reason: 'TRIGGER_FUNCTION_UNDEFINED' });
    }
  }
  return { findings: dedupe(findings), bodies, triggerFunctions: [...triggerFunctions].sort(), notifiers: [...notifiers].sort() };
}

function shippedSources () {
  const files = execFileSync('git', ['ls-files', '--', ...SCOPE], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter(file => /\.(js|cjs|json|sql)$/.test(file) && file !== 'scripts/check-no-trigger-notify.js');
  return files.map(file => ({ file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const sources = args.length ? args.map(file => ({ file, text: fs.readFileSync(file, 'utf8') })) : shippedSources();
  const result = scan(sources);
  console.log('trigger bodies scanned: ' + result.bodies);
  console.log('trigger functions: ' + result.triggerFunctions.length + ' (' + result.triggerFunctions.join(', ') + ')');
  console.log('notifying functions: ' + result.notifiers.length + ' (' + result.notifiers.join(', ') + ')');
  for (const finding of result.findings) console.log('FAIL ' + finding.reason + ' ' + finding.name + ' in ' + finding.file);
  if (!result.bodies) { console.log('FAIL NO_TRIGGER_FUNCTIONS_SCANNED'); process.exit(1); }
  if (result.findings.length) process.exit(1);
  console.log('OK no trigger emits NOTIFY');
}
module.exports = { scan };
