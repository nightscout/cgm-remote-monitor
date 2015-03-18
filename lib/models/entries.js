
var _ = require('lodash');

var config = {
    keys: ['sgv'  ]
  , fields: ['sgv', 'timestamp']
  // , 
};

function sgvs ( ) {

}


function make_timestamp ( ) {
}

function make_field ( ) {
}

function sanitizer (opts) {
  
}

function index (opts) {
  function calc (data) {
    var o = lo.pick(data, opts.keys);
    var scheme, r;
    var stack = [ ];
    if (o.type) {
      scheme = o.type + ':/';
    }
    opts.fields.forEach(function iter (elem) {
      stack.push(data[elem]);
    });
    r = [ scheme ].concat(stack).join('/');
    return r;
  }
  return calc;
}

module.exports = index;
