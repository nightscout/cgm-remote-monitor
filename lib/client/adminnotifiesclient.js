'use strict';

function init (client, $) {

  var notifies = {};

  client.notifies = notifies;

  notifies.notifies = [];
  notifies.drawer = $('#adminNotifiesDrawer');
  notifies.button = $('#adminnotifies');

  notifies.updateAdminNotifies = function updateAdminNotifies() {

    var src = '/api/v1/adminnotifies?t=' + new Date().getTime();

    $.ajax({
      method: 'GET'
      , url: src
      , headers: client.headers()
    }).done(function success (results) {
      if (results.message) {
        var m = results.message;
        client.notifies.notifies = m.notifies;
        client.notifies.notifyCount = m.notifyCount;
        if (m.notifyCount > 0) {
          notifies.button.show();
        }
      }
      window.setTimeout(notifies.updateAdminNotifies, 1000*60);
    }).fail(function fail () {
      console.error('Failed to load notifies');
      window.setTimeout(notifies.updateAdminNotifies, 1000*60);
    });
  }

  notifies.updateAdminNotifies();

  function wrapmessage(title, message) {
    return '<hr><p><b>' + title + '</b></p><p class="adminNotifyMessage">' + message + '</p>';
  }

  notifies.prepare = function prepare() {

    var html = '<div id="adminNotifyContent">';
    var messages = client.notifies.notifies;
    var messageCount = client.notifies.notifyCount;

    if (messages && messages.length > 0) {
      html += '<p><b>You have administration notifications</b></p>';
      for(var i = 0 ; i < messages.length; i++) {
        var m = messages[i];
        html += wrapmessage(m.title, m.message);
      }
    } else {
      if (messageCount > 0) {
        html = wrapmessage('Admin messages in queue', 'Please sign in using the API_SECRET to see your administration messages');
      } else {
        html = wrapmessage('Queue empty', 'There are no notifies in queue');
      }
    }
    html += '<hr></div>';
    notifies.drawer.html(html);
  }

  function maybePrevent (event) {
    if (event) {
      event.preventDefault();
    }
  }

  notifies.toggleDrawer = function toggleDrawer (event) {
    client.browserUtils.toggleDrawer('#adminNotifiesDrawer', notifies.prepare);
    maybePrevent(event);
  };

  notifies.button.click(notifies.toggleDrawer);
  notifies.button.css('color','red');

  return notifies;

}

module.exports = init;
