var fs = require('fs');
var chalk = require('chalk');

module.exports = {
  options: {
    sort: true,
    debug: true,
    func: {
      list: ['i18next.t', 'i18n.t', 'translate'],
      extensions: ['.js'] 
    },
    trans: {
      extensions: ['.js'],
      fallbackKey: (ns, value) => {
        return value;
      }
    },
    lngs: ['en', 'bg', 'cs', 'de', 'el', 'es', 'fi', 'fr', 'he', 'hr', 'it', 'ko', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv', 'zh_cn', 'zh_tw'],
    ns: [
      //'locale',
      'resource'
    ],
    defaultNs: 'resource',
    defaultValue: '', // use empty string for strings that don't have a translation. English will be shown
    resource: {
      loadPath: 'static/translations/language-{{lng}}-{{ns}}.json',
      savePath: 'static/translations/language-{{lng}}-{{ns}}.json'
    },
    nsSeparator: false, // namespace separator
    keySeparator: false, // key separator
    interpolation: {
      prefix: '{{',
      suffix: '}}'
    }
  },
  transform: function customTransform(file, enc, done) {
    "use strict";
    const parser = this.parser;
    const content = fs.readFileSync(file.path, enc);
    let count = 0;

    parser.parseFuncFromString(content, { list: ['i18next._', 'i18next.__', 'translate'] }, (key, options) => {
      parser.set(key, Object.assign({}, options, {
        nsSeparator: false,
        keySeparator: false
      }));
      ++count;
    });

    if (count > 0) {
      console.log(`i18next-scanner: count=${chalk.cyan(count)}, file=${chalk.yellow(JSON.stringify(file.relative))}`);
    }

    done();
  }
};