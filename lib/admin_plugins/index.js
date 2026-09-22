'use strict';

function init(ctx) {
    var allPlugins = [
        require('./subjects')(ctx)
      , require('./roles')(ctx)
      , require('./cleanstatusdb')(ctx)
      , require('./cleantreatmentsdb')(ctx)
      , require('./cleanentriesdb')(ctx)
      , require('./cleanprofiledb')(ctx)
      , require('./futureitems')(ctx)
      , require('./daterangedelete')(ctx)
    ];
  function plugins(name) {
    if (name) {
      return allPlugins.find(plugin => plugin.name === name);
    } else {
      return plugins;
    }
  }
  plugins.eachPlugin = function eachPlugin(f) {
    allPlugins.forEach(f);
  };

  plugins.createHTML = function createHTML(client) {
    var translate = client.translate;
    plugins.eachPlugin(function addHtml(p) {
      var fs = $('<fieldset>');
      $('#admin_placeholder').append(fs);
      fs.append($('<legend>').append(translate(p.label)));
      for (var i = 0; i < p.actions.length; i++) {
        if (i !== 0) {
          fs.append('<hr>');
        }
        var a = p.actions[i];
        if (a.name) {
          fs.append($('<b>').css('text-decoration','underline').append(translate(a.name)));
          fs.append('<br>');
        }
        fs.append($('<i>').append(translate(a.description)));
        fs.append($('<div>').attr('id','admin_' + p.name + '_' + i + '_html'));
        fs.append($('<button>').addClass('adminButton').attr('plugin',p.name).attr('action',i).append(translate(a.buttonLabel)));
        fs.append($('<span>').attr('id','admin_' + p.name + '_' + i + '_status'));
        if (a.init) {
          a.init(client);
        }
      }
      if (p.css) {
        $('<style>').prop('type', 'text/css').html(p.css).appendTo('head');
      }
    });
  };

  plugins.doAction = function doAction(event) {
    var Nightscout = window.Nightscout;
    var plugin = $(this).attr('plugin');
    var action = $(this).attr('action');
    var a = plugins(plugin).actions[action];
    var ok = true;
    if (a.confirmText) {
      ok = window.confirm(Nightscout.client.translate(a.confirmText));
    }
    if (ok) {
      console.log('Running action', action, 'on plugin', plugin);
      a.code(Nightscout.client);
      if (!a.preventClose) {
        $(this).css('display', 'none');
      }
    }
    if (event) {
      event.preventDefault();
    }
  };

  // Use a namespaced event to ensure we only remove our own listener
  $(document).off('click.adminPlugins').on('click.adminPlugins', '.adminButton', plugins.doAction);

  return plugins();
}

module.exports = init;
