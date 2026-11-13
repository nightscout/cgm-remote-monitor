'use strict';
// Configuration-only contract. Shared runtime parsers; no provisioning object,
// connection, HTTP request, Vault credential reader or secrets sink is created.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const bounds = require('./bounds');
const actual = require('../../../tenant-registry/provision');
const cli = require('../../../cli/commands/admin');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
function check (value) {
  let directory;
  try {
    bounds.inspect(value);
    if (!value || value.version !== 1 || !['direct-alias','canonical-internal'].includes(value.mode)) throw Error();
    let specs;
    if (value.interface === 'rest') {
      if (!exact(value,['version','mode','interface','specs'])) throw Error();
      specs = value.specs;
    } else if (value.interface === 'cli') {
      const extras = ['seed','environment'].filter(k => Object.hasOwn(value,k));
      if (!exact(value,['version','mode','interface','args',...extras]) || !Array.isArray(value.args) || value.args.length > 256 || value.args.some(x => typeof x !== 'string' || x.length > 65536)) throw Error();
      const options = cli.parseArgs(value.args);
      const env = value.environment || {};
      if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).some(k => !['ADMIN_HOSTNAME','ADMIN_PORT'].includes(k)) || Object.values(env).some(x => typeof x !== 'string')) throw Error();
      cli.endpoint(options,env); // Parses only; the HTTP call is deliberately absent.
      if (options.seed) {
        if (typeof value.seed !== 'string' || !/\.(json|csv)$/i.test(options.seed)) throw Error();
        directory = fs.mkdtempSync(path.join(os.tmpdir(),'ns-plan-seed-'));
        options.seed = path.join(directory, options.seed.toLowerCase().endsWith('.csv') ? 'seed.csv' : 'seed.json');
        fs.writeFileSync(options.seed,value.seed,{mode:0o600});
      } else if (Object.hasOwn(value,'seed')) throw Error();
      specs = cli.provisionRows(options);
      // The CLI partitions seeds into MAX_BATCH-sized actual REST requests.
      for (let start=0;start<specs.length;start+=options.batch || cli.MAX_BATCH) actual.checkBatch(specs.slice(start,start+(options.batch || cli.MAX_BATCH)),{mode:value.mode});
      for (const spec of specs) actual.parseSpec(spec,{mode:value.mode});
      return {ok:true,interface:'cli',tenants:specs.length,findings:[]};
    } else throw Error();
    actual.checkBatch(specs,{mode:value.mode});
    for (const spec of specs) actual.parseSpec(spec,{mode:value.mode});
    return {ok:true,interface:'rest',tenants:specs.length,findings:[]};
  } catch {
    return {ok:false,findings:[{code:'PLAN_PROVISIONING_REFUSED',message:'actual provisioning or CLI grammar refused input'}]};
  } finally { if (directory) fs.rmSync(directory,{recursive:true,force:true}); }
}
module.exports = { check };
