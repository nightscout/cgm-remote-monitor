var _ = require('lodash');

module.exports = function create_device_obscurity (env) {
  function obscure_device (req, res, next) {
    if (res.entries && env.settings.obscureDeviceProvenance) {
      var entries = _.cloneDeep(res.entries);
      for (var i = 0; i < entries.length; i++) {
        entries[i].device = env.settings.obscureDeviceProvenance;
      }
      res.entries = entries;
    }
    next( );
  }
  return obscure_device;
}
