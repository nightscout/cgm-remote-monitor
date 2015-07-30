'use strict';

function init () {
  return {
    reload: reload
  };
}

function reload() {
  //strip '#' so form submission does not fail
  var url = window.location.href;
  url = url.replace(/#$/, '');
  window.location = url;
}

module.exports = init;