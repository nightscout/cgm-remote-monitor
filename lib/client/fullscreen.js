'use strict';

const init = ($) => {

  // show expand/compress icon depending on whether fullscreen is enabled
  const showIcon = () => {
    if (document.fullscreenElement) {
      // fullscreen is enabled
      $('#fullscreenIcon').removeClass('icon-expand');
      $('#fullscreenIcon').addClass('icon-compress');
    } else {
      // fullscreen is not enabled
      $('#fullscreenIcon').removeClass('icon-compress');
      $('#fullscreenIcon').addClass('icon-expand');
    }
  };

  if (document.fullscreenEnabled) {

    // watch for fullscreen change events
    document
      .body
      .addEventListener("fullscreenchange", (event) => {
        showIcon();
        event.preventDefault();
      });

    // set up the click event handler for the fullscreen icon
    $('#fullscreen')
      .click((event) => {
        if (!document.fullscreenElement) {
          document
            .body
            .requestFullscreen()
            .catch(err => console.error(`failed to request fullscreen: ${err.message}`));
        } else {
          document
            .exitFullscreen()
            .catch(err => console.error(`failed to exit fullscreen: ${err.message}`));
        }
        event.preventDefault();
      });

    // now that everything is set up, make the fullscreen icon visible
    showIcon();
    $('#fullscreen').show();
  }
};

module.exports = init;
