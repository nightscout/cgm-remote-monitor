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

  function wrapmessage(title, message, count, ago, persistent, seeAlso) {
    let html = $('<div><div><hr><p><b class="adminNotifyTitle"></b></p><p class="adminNotifyMessage"></p></div><p class="adminNotifyMessageAdditionalInfo"></p></div>');
    html.find('.adminNotifyTitle').text(title);
    html.find('.adminNotifyMessage').text(message);

    let additional = '';

    if (count > 1) additional += client.translate('Event repeated %1 times.', count) + ' ';
    let units = client.translate('minutes');
    if (ago > 60) {
      ago = ago / 60;
      ago = Math.round((ago + Number.EPSILON) * 10) / 10;
      units = client.translate('hours');
    }
    if (ago == 0) { ago = client.translate('less than 1'); }
    if (!persistent && ago) additional += client.translate('Last recorded %1 %2 ago.', ago, units);

    html.find('.adminNotifyMessageAdditionalInfo').text(additional);
    if (seeAlso && init.addendums[seeAlso]) {
      html.append($(init.addendums[seeAlso]));
    }
    return html.html( );
  }

  notifies.prepare = function prepare() {

    var translate = client.translate;

    var html = '<div id="adminNotifyContent">';
    var messages = client.notifies.notifies;
    var messageCount = client.notifies.notifyCount;

    if (messages && messages.length > 0) {
      html += '<p><b>' + translate('You have administration messages') + '</b></p>';
      for(var i = 0 ; i < messages.length; i++) {
        /* eslint-disable-next-line security/detect-object-injection */ // verified false positive
        var m = messages[i];
        const ago = Math.round((Date.now() - m.lastRecorded) / 60000);
        html += wrapmessage(translate(m.title), translate(m.message), m.count, ago, m.persistent, m.seeAlso);
      }
    } else {
      if (messageCount > 0) {
        html = wrapmessage(translate('Admin messages in queue'), translate('Please sign in using the API_SECRET to see your administration messages'));
      } else {
        html = wrapmessage(translate('Queue empty'), translate('There are no admin messages in queue'));
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
init.addendums = {
  disableWorldReadable: '<p>Please consider closing access to the site by following the instructions in the <a href="http://nightscout.github.io/nightscout/security/#how-to-turn-off-unauthorized-access" target="_new">Nightscout documentation</a>.</p>'

};

module.exports = init;
