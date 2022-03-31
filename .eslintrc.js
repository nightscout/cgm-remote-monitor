module.exports = {
    "plugins": [ ],
    "extends": [
      "eslint:recommended"
    ],
    "parser": "babel-eslint",
    "env": {
      "browser": true,
      "commonjs": true,
      "es6": true,
      "node": true,
      "mocha": true,
      "jquery": true
    },
    "rules": {
      "no-unused-vars": [
        "error",
        {
          "varsIgnorePattern": "should|expect"
        }
      ]
    }
  };