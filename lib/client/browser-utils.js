'use strict';

var SMALL_SCREEN = 500;

function init ($) {
  var lastOpenedDrawer = null;

  // Help tooltips are delegated from the document, so they also cover the
  // dashboard DOM that the effective theme may substitute after this point.
  // initTooltips is kept for the client's post-theme call and is idempotent.
  function initTooltips () {
    return require('./help-tooltips')(document, {touch: isTouch()});
  }
  initTooltips();

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
    try { document.createEvent('TouchEvent'); return true; } catch { return false; }
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

  // Full window on a small screen, otherwise a 350px column below the toolbar.
  function drawerSize () {
    var windowWidth = $(window).width();
    var windowHeight = $(window).height();
    if (windowWidth < SMALL_SCREEN || (windowHeight < SMALL_SCREEN) && windowWidth < 800) {
      return { top: '0px', height: windowHeight + 'px', width: windowWidth + 'px' };
    }
    return { top: '0px', height: (windowHeight - 45) + 'px', width: '350px' };
  }

  // A resize that leaves the drawer open (a chart width change closes it)
  // must not keep the size it was opened at. Registered at the first open,
  // so init stays free of window access (the no-DOM tests call it).
  var resizeRegistered = false;
  function resizeOpenDrawer () {
    if (lastOpenedDrawer) {
      $(lastOpenedDrawer).css(drawerSize());
    }
  }

  function openDrawer (id, prepare) {
    function closeOpenDraw (callback) {
      if (lastOpenedDrawer) {
        closeDrawer(lastOpenedDrawer, callback);
      } else {
        callback();
      }
    }

    if (!resizeRegistered) {
      $(window).on('resize', resizeOpenDrawer);
      resizeRegistered = true;
    }

    closeOpenDraw(function() {
      lastOpenedDrawer = id;
      if (prepare) { prepare(); }

      var style = drawerSize();
      style.display = 'block';
      style.right = '0';

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
