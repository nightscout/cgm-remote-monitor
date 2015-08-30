'use strict';

var traverse = require('traverse');
var ObjectID = require('mongodb').ObjectID;

var TWO_DAYS = 172800000;

function default_options (opts) {
  opts = opts || { };
  if (opts) {
    var keys = [null].concat(Object.keys(opts));
    // if (keys.indexOf('laxDate') < 1) { opts.laxDate = false; }
    if (keys.indexOf('deltaAgo') < 1) {
      opts.deltaAgo = ( TWO_DAYS * 2 );
    }
    if (keys.indexOf('walker') < 1) {
      opts.walker = { date: parseInt, sgv: parseInt };
    }
  }
  return opts;
}

function create (params, opts) {
  opts = default_options(opts);
  var finder = walker(opts.walker)(params);
  var query = finder && finder.find ? finder.find : { };
  var dateField = opts.dateField || 'date';
  var dateValue = query[dateField];

  if (!dateValue && !query.dateString) {
    // if (!laxDate) { }
    var minDate = Date.now( ) - opts.deltaAgo;
    query[dateField] = {
      $gte: opts.useISO ? new Date(minDate).toISOString() : minDate
    };
  }
  if (query._id && query._id.length) {
    query._id = ObjectID(query._id);
  }
  return query;
}

function walker (spec) {
  var fns = [ ];
  var keys = Object.keys(spec);
  keys.forEach(function config (prop) {
    var typer = spec[prop];
    fns.push(walk_prop(prop, typer));
  });

  function exec (obj) {
    var fn;
    while (fns.length > 0) {
      fn = fns.shift( );
      obj = fn(obj);
    }
    return obj;
  }
  return exec;
}

function walk_prop (prop, typer) {
  function iter (opts) {
    if (opts && opts.find && opts.find[prop]) {
      traverse(opts.find[prop]).forEach(function (x) {
        if (this.isLeaf) {
          this.update(typer(x));
        }
      });
    }
    return opts;
  }
  return iter;
}

walker.walk_prop = walk_prop;
create.walker = walker;
create.default_options = default_options;

exports = module.exports = create;

