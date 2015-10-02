
var es = require('event-stream');

function create (core) {
  function heartbeat (ev) {

  }
  core.inputs.on('heartbeat', heartbeat);
  function make (beat) {
    var poll = {heart: beat};
    return poll;
  }
  function writer (data) {
  }
  var poller = es.through(writer);
}

module.exports = create;
