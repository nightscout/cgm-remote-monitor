'use strict';

const init = ($) => {

  // whether the browser supports wake lock
  const isWakeLockSupported = 'wakeLock' in navigator;

  if (isWakeLockSupported) {

    const showWakeLockEnabled = () => {
      $('#wakeLockIcon').attr('class', 'icon-sun');
    };

    const showWakeLockDisabled = () => {
      $('#wakeLockIcon').attr('class', 'icon-moon');
    };

    // the currently enabled wake lock, if any
    let wakeLockSentinel = null;

    // enable or reacquire wake lock
    const enableWakeLock = () => {
      navigator.wakeLock.request('screen')
        .then((x) => {
          wakeLockSentinel = x;
          wakeLockSentinel
            .addEventListener('release', () => {
              showWakeLockDisabled();
            });
          showWakeLockEnabled();
        })
        .catch((e) => {
          if (wakeLockSentinel === null || wakeLockSentinel.released) {
            showWakeLockDisabled();
          } else {
            showWakeLockEnabled();
          }
        });
    };

    // release wake lock, if present
    const disableWakeLock = () => {
      if (wakeLockSentinel !== null) {
        wakeLockSentinel.release()
          .then(() => {
            wakeLockSentinel = null;
            showWakeLockDisabled();
          })
          .catch((e) => {
            if (wakeLockSentinel === null || wakeLockSentinel.released) {
              showWakeLockDisabled();
            } else {
              showWakeLockEnabled();
            }
          });
      }
    };

    // determine whether the browser window is currently visible
    const isBrowserVisible = () => {
      return document.visibilityState === 'visible';
    };

    // whether the user has clicked on the wake lock icon
    let isWakeLockRequested = false;

    // enable or disable wake lock, as appropriate
    const updateWakeLock = () => {
      if (isWakeLockRequested && isBrowserVisible()) {
        enableWakeLock();
      } else {
        disableWakeLock();
      }
    };

    // re-setup the wake lock whenever the window visibility changes
    document.addEventListener('visibilitychange', updateWakeLock);

    // set up the click event handler for the wake lock icon
    $('#wakeLock')
      .click((event) => {
        isWakeLockRequested = !isWakeLockRequested;
        updateWakeLock();
        event.preventDefault();
      });

    // now that everything is set up, make the wake lock icon visible
    $('#wakeLock').show();
  }
};

module.exports = init;
