
var es = require('event-stream');
var dispatcher = require('./dispatcher');
  ;

function init (ctx) {
  ctx.inputs.on('data', console.log.bind(console, 'DEBUG DATA'));
  ctx.inputs.on('sgv', console.log.bind(console, 'DEBUG SGV DATA'));
  ctx.inputs.on('/download/protobuf', console.log.bind(console, 'DEBUG DOWNLOAD DATA'));
  ctx.inputs.write({msg: 'hello world'});

  ctx.heartbeat.pipe(ctx.inputs);
  ctx.heartbeat.uptime( );
}

function core (env, ctx) {
  var events = ctx.inputs = dispatcher(env, ctx);
  var store = ctx.store;

  ctx.pushover = require('./pushover')(env);
  ctx.entries = require('./entries')(env.mongo_collection, ctx.store, ctx.inputs);
  ctx.settings = require('./settings')(env.settings_collection, ctx.store, ctx.inputs);
  ctx.treatments = require('./treatments')(env.treatments_collection, ctx.store, ctx.pushover, ctx.inputs);
  ctx.devicestatus = require('./devicestatus')(env.devicestatus_collection, ctx.store, ctx.inputs);
  ctx.pebble = require('./pebble');
  console.info("Ensuring indexes");

  store.ensureIndexes(ctx.entries( ), ctx.entries.indexedFields);
  store.ensureIndexes(ctx.treatments( ), ctx.treatments.indexedFields);
  store.ensureIndexes(ctx.devicestatus( ), ctx.devicestatus.indexedFields);


  ctx.heartbeat = require('./ticker')(env, ctx)
     ;
     // .pipe(ctx.inputs);

  if (env.MQTT_MONITOR) {
    var mqtt = require('./mqtt')(env, ctx.inputs);
    var es = require('event-stream');
    // es.pipeline(mqtt.entries, ctx.entries.map( ), mqtt.every(ctx.entries));
  }
  events.init = init;
  return events;
}

module.exports = core;


