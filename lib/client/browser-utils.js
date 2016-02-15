'use strict';

var SMALL_SCREEN = 500;

function init ($) {
  var lastOpenedDrawer = null;

  // Tooltips can remain in the way on touch screens.
  if (!isTouch()) {
    $('.tip').tipsy();
  } else {
    // Drawer info tips should be displayed on touchscreens.
    $('#drawer').find('.tip').tipsy();
  }
  $.fn.tipsy.defaults = {
    fade: true,
    gravity: 'n',
    opacity: 0.75
  };

  var querystring = queryParms();

  if (querystring.notify) {
    showNotification(querystring.notify, querystring.notifytype);
  }

  if (querystring.drawer) {
    openDrawer('#drawer');
  }

  $('#drawerToggle').click(function(event) {
    toggleDrawer('#drawer');
    event.preventDefault();
  });

  $('#notification').click(function(event) {
    closeNotification();
    event.preventDefault();
  });

  $('.navigation a').click(function navigationClick ( ) {
    closeDrawer('#drawer');
  });

  function reload() {
    //strip '#' so form submission does not fail
    var url = window.location.href;
    url = url.replace(/#$/, '');
    window.location = url;
  }


  function queryParms() {
    var params = {};
    if (location.search) {
      location.search.substr(1).split('&').forEach(function(item) {
        params[item.split('=')[0]] = item.split('=')[1].replace(/[_\+]/g, ' ');
      });
    }
    return params;
  }

  function isTouch() {
    try { document.createEvent('TouchEvent'); return true; }
    catch (e) { return false; }
  }

  function closeDrawer(id, callback) {
    lastOpenedDrawer = null;
    $('html, body').css({ scrollTop: 0 });
    $(id).css({display: 'none', right: '-300px'});
    if (callback) { callback(); }
  }

  function openDrawer(id, prepare) {
    function closeOpenDraw(callback) {
      if (lastOpenedDrawer) {
        closeDrawer(lastOpenedDrawer, callback);
      } else {
        callback();
      }
    }

    closeOpenDraw(function () {
      lastOpenedDrawer = id;
      if (prepare) { prepare(); }

      var style = {display:'block', right: '0'};

      var windowWidth = $(window).width();
      if (windowWidth < SMALL_SCREEN || ($(window).height() < SMALL_SCREEN) && windowWidth < 800) {
        style.width = windowWidth + 'px';
        var top = $("#chartContainer").offset().top - 45;
        style.top = top + 'px';
        style.height = ($(window).height() - top - 45) + 'px';
      } else {
        style.top = '0px';
        style.height = ($(window).height() - 45) + 'px';
        style.width = '350px';
      }


      $(id).css(style);
    });

  }

  function toggleDrawer(id, openPrepare, closeCallback) {
    if (lastOpenedDrawer === id) {
      closeDrawer(id, closeCallback);
    } else {
      openDrawer(id, openPrepare);
    }
  }

  function closeNotification() {
    var notify = $('#notification');
    notify.hide();
    notify.find('span').html('');
  }

  function showNotification(note, type)  {
    var notify = $('#notification');
    notify.hide();

    // Notification types: 'info', 'warn', 'success', 'urgent'.
    // - default: 'urgent'
    notify.removeClass('info warn urgent');
    notify.addClass(type ? type : 'urgent');

    notify.find('span').html(note);
    var windowWidth = $(window).width();
    var left = (windowWidth - notify.width()) / 2;
    notify.css('left', left + 'px');
    notify.show();
  }

  function getLastOpenedDrawer() {
    return lastOpenedDrawer;
  }
  
  return {
    reload: reload
    , queryParms: queryParms
    , closeDrawer: closeDrawer
    , toggleDrawer: toggleDrawer
    , closeNotification: closeNotification
    , showNotification: showNotification
    , getLastOpenedDrawer: getLastOpenedDrawer
  };
}

module.exports = init;
