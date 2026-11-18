'use strict';

// No core role refuses a configuration on this value: operating limits come
// from measurement (decision m7-envelope-measured-not-declared). It remains
// only as the range the nightscout-deploy Compose binding reads for its
// synthetic tenant count, until that binding stops reading it; then this
// module is removed. The size of each configuration file is bounded
// separately (MULTITENANT_CONFIG_MAX_BYTES, lib/server/serve/config-file.js).
const PREVIEW_MAX_TENANTS = 10000;

module.exports = { PREVIEW_MAX_TENANTS };
