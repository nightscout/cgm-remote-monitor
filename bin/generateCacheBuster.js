'use strict';

const { randomBytes } = require('node:crypto');
console.log(randomBytes(8).toString('hex'));
