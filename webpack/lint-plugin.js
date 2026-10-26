'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {ESLint} = require('eslint');

// Nightscout's development policy: display lint diagnostics without blocking
// compilation or HMR. Configuration/engine failures still fail the compilation.
module.exports = class DevelopmentLintPlugin {
  apply(compiler) {
    // Webpack resolves module symlinks; compare against the same physical root.
    const context = fs.realpathSync(compiler.context);
    const eslint = new ESLint({
      cwd: context,
      overrideConfig: {languageOptions: {globals: {'$': 'writable'}}}
    });
    compiler.hooks.thisCompilation.tap('NightscoutDevelopmentLint', compilation => {
      const files = new Set();
      function add(module) {
        if (!module.resource) return;
        const file = module.resource.split('?')[0];
        const relative = path.relative(context, file);
        if (path.extname(file) === '.js' && !path.isAbsolute(relative) &&
            relative !== '..' && !relative.startsWith('..' + path.sep) &&
            !relative.split(path.sep).includes('node_modules')) files.add(file);
      }
      compilation.hooks.succeedModule.tap('NightscoutDevelopmentLint', add);
      compilation.hooks.stillValidModule.tap('NightscoutDevelopmentLint', add);
      compilation.hooks.processAssets.tapPromise('NightscoutDevelopmentLint', async () => {
        if (!files.size) return;
        const results = await eslint.lintFiles([...files]);
        const formatter = await eslint.loadFormatter('stylish');
        const text = await formatter.format(results);
        if (text) {
          const warning = new Error(text);
          warning.name = 'NightscoutLintWarning';
          compilation.warnings.push(warning);
        }
      });
    });
  }
};
