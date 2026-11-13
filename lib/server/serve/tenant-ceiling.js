'use strict';

// The multitenant preview's tenant ceiling: the most tenants one deployment's
// role configuration may list. The admin role's ownership roster and the
// Compose ui read it here; the deployable Compose configuration
// (nightscout-deploy) takes its tenant-count range from it. The size of each
// configuration file is bounded separately (MULTITENANT_CONFIG_MAX_BYTES,
// lib/server/serve/config-file.js).
const PREVIEW_MAX_TENANTS = 10000;

module.exports = { PREVIEW_MAX_TENANTS };
