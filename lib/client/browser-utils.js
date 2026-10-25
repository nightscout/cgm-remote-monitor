'use strict';

var SMALL_SCREEN = 500;

function init ($) {
  var lastOpenedDrawer = null;

  // Run after the effective theme has selected its dashboard DOM.
  function initTooltips () {
    // Tooltips can remain in the way on touch screens; drawer tips are useful.
    var targets = isTouch() ? $('#drawer').find('.tip') : $('.tip');
    targets.filter(function () { return !$(this).data('tooltip'); }).tooltip();
    $.fn.tooltip.defaults = Object.assign({}, $.fn.tooltip.defaults, {
      fade: true
      , gravity: 'n'
      , opacity: 0.9
    });
  }

  // The effective browser theme can replace the server-rendered dashboard
  // after initialization. Delegate controls that live inside that dashboard.
  $(document).on('click', '#drawerToggle', function(event) {
    toggleDrawer('#drawer');
    event.preventDefault();
  });

  $(document).on('click', '#notification', function(event) {
    closeNotification();
    event.preventDefault();
  });

  $('.navigation a').click(function navigationClick () {
    closeDrawer('#drawer');
  });

  function reload () {
    //strip '#' so form submission does not fail
    var url = window.location.href;
    url = url.replace(/#$/, '');
    window.location.href = url;
  }

  function queryParms () {
    var params = {};
    if ((typeof location !== 'undefined') && location.search) {
      location.search.substr(1).split('&').forEach(function(item) {
        // A segment with no `=` has no [1] to call .replace on, and an empty
        // segment has no name either. Both used to throw, and this is called
        // from the first line of client.init - so `?debug`, a trailing `&`,
        // or a bare `?` stopped the page loading at all, with nothing on
        // screen but the loading message.
        //
        // A valueless parameter reads as the empty string, which is what both
        // existing callers already treat as absent (`|| clientToken`,
        // `!== 'true'`). The split itself is left exactly as it was, second
        // `=` truncation included, so a well-formed URL parses identically.
        if (!item) { return; }
        var parts = item.split('=');
        // `+` means space in a query string. `_` does not, in any encoding,
        // and replacing it corrupted every access token whose subject name
        // contained one - `mom_phone-89e1...` arrived here as
        // `mom phone-89e1...`. That went unnoticed because findSubject
        // matches on the LAST `-`-separated segment, the 16-hex digest, and
        // ignores the abbreviated name in front of it. The corruption was
        // real and the leniency downstream was what absorbed it; neither was
        // chosen.
        //
        // Deliberately NOT decodeURIComponent: it throws on a malformed
        // percent sequence, and this function is called from the first line
        // of client.init, which is the throw this file was just fixed for.
        // Neither caller needs percent decoding - the two parameters read
        // here are an access token and `mute`.
        params[parts[0]] = (parts.length > 1 ? parts[1] : '').replace(/\+/g, ' ');
      });
    }
    return params;
  }

  function isTouch () {
    try { document.createEvent('TouchEvent'); return true; } catch (e) { return false; }
  }

  function closeLastOpenedDrawer (callback) {
    if (lastOpenedDrawer) {
      closeDrawer(lastOpenedDrawer, callback);
    } else if (callback) {
      callback();
    }
  }

  function closeDrawer (id, callback) {
    lastOpenedDrawer = null;
    $('html, body').css({ scrollTop: 0 });
    var drawer = $(id);
    transitionDrawer(drawer, false, function () {
      drawer.css({ display: 'none', right: '-300px' });
    });
    if (callback) { callback(); }
  }

  function transitionDrawer (drawer, opening, done) {
    var element = drawer[0];
    var modern = document.documentElement.classList.contains('modern-ui');
    var previous = drawer.data('drawerAnimation');
    var from = previous && window.getComputedStyle(element);
    var transform = from ? from.transform : (opening ? 'translateX(100%)' : 'translateX(0)');
    var opacity = from ? from.opacity : (opening ? 0.6 : 1);
    if (previous) {
      previous.onfinish = null;
      previous.cancel();
      drawer.removeData('drawerAnimation');
    }
    if (!modern || !element || !element.animate ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      done();
      return;
    }
    var animation = element.animate([
      {transform: transform, opacity: opacity},
      {transform: opening ? 'translateX(0)' : 'translateX(100%)', opacity: opening ? 1 : 0.6}
    ], {duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)'});
    drawer.data('drawerAnimation', animation);
    animation.onfinish = function () {
      drawer.removeData('drawerAnimation');
      done();
      animation.cancel();
    };
  }

  function openDrawer (id, prepare) {
    function closeOpenDraw (callback) {
      if (lastOpenedDrawer) {
        closeDrawer(lastOpenedDrawer, callback);
      } else {
        callback();
      }
    }

    closeOpenDraw(function() {
      lastOpenedDrawer = id;
      if (prepare) { prepare(); }

      var style = { display: 'block', right: '0' };

      var windowWidth = $(window).width();
      var windowHeight = $(window).height();
      //var chartTop = $('#chartContainer').offset().top - 45;
      //var chartHeight = windowHeight - chartTop - 45;
      if (windowWidth < SMALL_SCREEN || (windowHeight < SMALL_SCREEN) && windowWidth < 800) {
        style.top = '0px';
        style.height = windowHeight + 'px';
        style.width = windowWidth + 'px';
        //TODO: maybe detect iOS and do this, doesn't work good with android
        //if (chartHeight > windowHeight * 0.4) {
        //  style.top = chartTop + 'px';
        //  style.height = chartHeight + 'px';
        //}
      } else {
        style.top = '0px';
        style.height = (windowHeight - 45) + 'px';
        style.width = '350px';
      }

      $(id).css(style);
      transitionDrawer($(id), true, function () {});
    });

  }

  function toggleDrawer (id, openPrepare, closeCallback) {
    if (lastOpenedDrawer === id) {
      closeDrawer(id, closeCallback);
    } else {
      openDrawer(id, openPrepare);
    }
  }

  function closeNotification () {
    var notify = $('#notification');
    notify.hide();
    notify.find('span').html('');
  }

  function showNotification (note, type) {
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

  function getLastOpenedDrawer () {
    return lastOpenedDrawer;
  }

  return {
    reload: reload
    , initTooltips: initTooltips
    , queryParms: queryParms
    , closeDrawer: closeDrawer
    , closeLastOpenedDrawer: closeLastOpenedDrawer
    , toggleDrawer: toggleDrawer
    , closeNotification: closeNotification
    , showNotification: showNotification
    , getLastOpenedDrawer: getLastOpenedDrawer
  };
}

module.exports = init;
