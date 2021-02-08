module.exports = {
    'plugins': [
      'security'
    ],
    'extends': [
      'eslint:recommended',
      'plugin:security/recommended'
    ],
    'parser': 'babel-eslint',
    'env': {
      'browser': true,
      'commonjs': true,
      'es6': true,
      'node': true,
      'mocha': true,
      'jquery': true
    },
    'rules': {
      'security/detect-object-injection' : 0,
      'no-unused-vars': [
        'error',
        {
          'varsIgnorePattern': 'should|expect'
        }
      ]
    },
    'overrides': [
      {
        'files': ['lib/client/*.js'],
        'rules': {
          'security/detect-object-injection': 0
        }
      }
    ],
  };