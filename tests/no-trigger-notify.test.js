'use strict';

// Decision D6: notifications come from the slot reader, never from a write
// trigger. scripts/check-no-trigger-notify.js is the gate; these are its
// controls (each planted shape must be refused) and the shipped-tree run.
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { scan } = require('../scripts/check-no-trigger-notify');

const reasons = sources => scan(sources).findings.map(f => f.reason).sort();
const trig = body => 'CREATE FUNCTION s.t() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN ' + body + ' RETURN NEW; END $x$;\n' +
  'CREATE TRIGGER t AFTER INSERT ON s.clinical FOR EACH ROW EXECUTE FUNCTION s.t();';

describe('no trigger emits NOTIFY (D6)', function () {
  it('refuses pg_notify in a trigger function', function () {
    assert.ok(reasons([{ file: 'a.sql', text: trig("PERFORM pg_notify('c', NEW.tenant_id::text);") }]).includes('TRIGGER_EMITS_NOTIFY'));
  });
  it('refuses a NOTIFY statement in a trigger function', function () {
    assert.ok(reasons([{ file: 'a.sql', text: trig('NOTIFY ns_change;') }]).includes('TRIGGER_EMITS_NOTIFY'));
  });
  it('refuses a trigger that calls a notifying function, in another file', function () {
    const helper = "CREATE FUNCTION s.signal(t uuid) RETURNS void LANGUAGE plpgsql AS $y$ BEGIN PERFORM pg_notify('c', t::text); END $y$;";
    assert.ok(reasons([{ file: 'a.sql', text: trig('PERFORM s.signal(NEW.tenant_id);') }, { file: 'b.json', text: JSON.stringify({ up: [helper] }) }])
      .includes('TRIGGER_EMITS_NOTIFY'));
  });
  it('refuses a trigger function whose name is built in JavaScript', function () {
    const text = "q('CREATE FUNCTION ' + name + '() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify(\\'c\\', \\'x\\'); END $$')";
    assert.ok(reasons([{ file: 'a.js', text }]).includes('TRIGGER_EMITS_NOTIFY'));
  });
  it('refuses a rewrite rule that notifies', function () {
    assert.ok(reasons([{ file: 'a.sql', text: 'CREATE RULE r AS ON INSERT TO s.entries DO ALSO NOTIFY ns_change;' }]).includes('RULE_NOTIFIES'));
  });
  it('refuses a trigger function whose body it cannot read', function () {
    assert.ok(reasons([{ file: 'a.sql', text: 'CREATE FUNCTION s.t() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW;' }]).includes('TRIGGER_FUNCTION_BODY_UNREADABLE'));
  });
  it('admits a notifying function no trigger calls (the slot reader shape) and a quiet trigger', function () {
    const reader = "CREATE FUNCTION s.change_feed_step() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $r$ BEGIN PERFORM pg_notify('ns_change', 'v1'); END $r$;";
    assert.deepStrictEqual(reasons([{ file: 'a.sql', text: reader + '\n' + trig('NEW.n := 1;') }]), []);
  });
  it('reads a function name as text, never as a pattern', function () {
    const notifier = name => 'CREATE FUNCTION s.' + name + "() RETURNS void LANGUAGE plpgsql AS $y$ BEGIN PERFORM pg_notify('c', 'x'); END $y$;";
    // The quoted names hold a class escape and an open group; neither is the quiet a1() the trigger calls.
    assert.deepStrictEqual(reasons([{ file: 'a.sql', text: notifier('"a\\d"') + '\n' + notifier('"sig(nal"') + '\n' + trig('PERFORM a1(NEW.n);') }]), []);
    const helper = "CREATE FUNCTION s.sig$nal(t uuid) RETURNS void LANGUAGE plpgsql AS $y$ BEGIN PERFORM pg_notify('c', t::text); END $y$;";
    const relay = 'CREATE FUNCTION s.relay(t uuid) RETURNS void LANGUAGE plpgsql AS $z$ BEGIN PERFORM s.sig$nal(t); END $z$;';
    assert.ok(reasons([{ file: 'a.sql', text: helper + '\n' + relay + '\n' + trig('PERFORM s.relay(NEW.tenant_id);') }]).includes('TRIGGER_EMITS_NOTIFY'));
  });
  it('passes on the shipped tree and scans its trigger bodies', function () {
    const out = execFileSync(process.execPath, [path.join(__dirname, '../scripts/check-no-trigger-notify.js')], { encoding: 'utf8' });
    assert.match(out, /OK no trigger emits NOTIFY/);
    assert.ok(Number(/trigger bodies scanned: (\d+)/.exec(out)[1]) > 0);
  });
});
