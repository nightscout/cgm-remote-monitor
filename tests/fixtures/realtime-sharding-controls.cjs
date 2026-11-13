'use strict';
// Fixture-only bounded slow-projection barrier. Never changes role admission,
// current authority, database responses or a clinical result.
const fs = require('node:fs'), path = require('node:path');
const Module=require('node:module'),compile=Module.prototype._compile;
Module.prototype._compile=function(source,filename){
  if(filename.endsWith('/serve/preview-realtime.js'))source=source.replace("  } catch {\n    await close(); throw new PreviewConfigError","  } catch (error) { process.stderr.write('SHARD_RT_BOOT '+String(error.code||error.message).replace(/\\b[a-z]+:\\/\\/\\S+/gi,'[endpoint]').slice(0,160)+'\\n');\n    await close(); throw new PreviewConfigError");
  return compile.call(this,source,filename);
};
const file = require.resolve('../../lib/server/realtime/projection'), create = require(file);
require.cache[file].exports = function (options) {
  const projection = create(options), marker = path.join(process.env.NS_SHARD_WARM_CONTROL_DIR, 'hold-' + options.current.tenant);
  return Object.freeze({ ...projection, async acquire (input) {
    if (fs.existsSync(marker)) fs.writeFileSync(marker + '-entered', '');
    while (fs.existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 10));
    const next = await projection.acquire(input);
    if (fs.existsSync(path.join(process.env.NS_SHARD_WARM_CONTROL_DIR, 'fail-' + options.current.tenant))) throw new Error('SHARD_FIXTURE_PROJECTION_FAILURE');
    return next;
  } });
};
