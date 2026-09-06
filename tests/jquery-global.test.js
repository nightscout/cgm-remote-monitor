'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../lib/client/jquery-global'),'utf8');

describe('Browser jQuery global ownership', function () {
  for(const mode of ['production','development']) {
    it('exposes and exports the same module in '+mode, function () {
      const jquery={fn:{}};const window={};const module={exports:{}};
      vm.runInNewContext(source,{window,module,require:()=>jquery,process:{env:{NODE_ENV:mode}}});
      assert.equal(window.$,jquery);assert.equal(module.exports,jquery);
      assert.equal(window.jQuery,undefined);
    });
    for(const existing of [null,42,{foreign:true}]) {
      it('preserves a preexisting global in '+mode+' ('+typeof existing+')',function () {
        const window={$:existing};const module={exports:{}};const jquery={};
        const run=()=>vm.runInNewContext(source,{window,module,require:()=>jquery,process:{env:{NODE_ENV:mode}}});
        if(mode==='development') assert.throws(run,/already exists/);else {run();assert.equal(module.exports,jquery);}
        assert.equal(window.$,existing);
      });
    }
  }
});
