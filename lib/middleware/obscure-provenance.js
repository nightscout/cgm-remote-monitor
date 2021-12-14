
module.exports = function create_device_obscurity (env) {
  function obscure_device (req, res, next) {
    if (res.entries && env.settings.obscureDeviceProvenance) {
      for (var i = 0; i < res.entries.length; i++) {
        res.entries[i].device = env.settings.obscureDeviceProvenance;
      }
    }
    next( );
  }
  return obscure_device;
}
