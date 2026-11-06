'use strict';

// The app entry initializes the shared client before this page entry.
window.Nightscout.profileclient = require('../lib/profile/profileeditor');

if (module.hot) module.hot.accept();
