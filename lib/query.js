'use strict';

var traverse = require('traverse');
var ObjectID = require('mongodb').ObjectID;

var TWO_DAYS = 172800000;

function default_options (opts) {
  if (!opts) {
    opts = { };
  }
  if (opts) {
    // if (!'laxDate' in opts) { opts.laxDate = false; }
    if (!'deltaAgo' in opts) {
      opts.deltaAgo = ( TWO_DAYS * 2 );
    }
    if (!'walker' in opts) {
      opts.walker = { date: parseInt, sgv: parseInt };
    }
  }
  return opts;
}

function create (params, opts) {
  opts = default_options(opts);
  var finder = walker(opts.walker)(params);
  var query = finder && finder.find ? finder.find : { };
  if (!query.date && !query.dateString) {
    // if (!laxDate) { }
    query.date = { $gte: Date.now( ) - opts.deltaAgo };
  }
  if (query._id && query._id.length) {
    query._id = ObjectID(query._id);
  }
  return query;
}

function walker (spec) {
  var fns = [ ];
  for (var prop in spec) {
    var typer = spec[prop];
    fns.push(walk_prop(prop, typer));
  }

  function exec (obj) {
    var fn;
    while (fn = fns.shift( )) {
      obj = fn(obj);
    }
    return obj;
  }
  return exec
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

