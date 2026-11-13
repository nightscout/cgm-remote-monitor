'use strict';

// `nightscout plan`: the deployment plan contract (decision
// deployment-plan-contract; lib/server/serve/plan-contract; reference
// docs/multitenant-plan-contract.md).
//
//   nightscout plan check <document-set.json | ->
//       Checks a plan's generated role documents against this core: each
//       document's shape, then the role loaders and start-up rules the role
//       processes themselves run. Opens no connection. Prints the report as
//       JSON on stdout and one summary line on stderr.
//   nightscout plan contract
//       Prints the contract as one JSON value: its version, the document-set
//       and role document schemas, and the provisioning interface (OpenAPI).
//
//   exit 0   every process in the set is accepted (check), or printed (contract)
//   exit 1   at least one finding
//   exit 64  usage, or a document set that cannot be read as JSON
const bounds = require('../../server/serve/plan-contract/bounds');

const EX_USAGE = 64;


function run (args, io) {
  const usage = message => { io.stderr.write('nightscout plan: ' + message + '\nusage: nightscout plan check <document-set.json | ->\n       nightscout plan contract\n'); return EX_USAGE; };
  const contract = require('../../server/serve/plan-contract');
  if (args.length === 1 && args[0] === 'contract') {
    io.stdout.write(JSON.stringify(contract.describe(), null, 2) + '\n');
    return 0;
  }
  if (args.length !== 2 || args[0] !== 'check') return usage('expected `check <file>` or `contract`');
  let set;
  try {
    // Operator-selected path from the command line; no request selects it.
    const text = bounds.read(args[1]);
    set = JSON.parse(text.toString('utf8'));
  } catch { return usage('the document set cannot be read as JSON'); }
  let report;
  try { report = contract.check(set); io.stdout.write(JSON.stringify(report, null, 2) + '\n'); }
  catch { io.stderr.write('nightscout plan: check could not complete safely\n'); return 1; }
  const findings = report.findings.length + report.processes.reduce((sum, row) => sum + row.findings.length, 0) + (report.provisioning || []).reduce((sum,row) => sum + row.findings.length,0);
  io.stderr.write('nightscout plan: contract ' + report.contract + ', ' + report.processes.length + ' processes, ' + findings + ' findings: ' + (report.ok ? 'accepted' : 'refused') + '\n');
  return report.ok ? 0 : 1;
}

module.exports = { run };
