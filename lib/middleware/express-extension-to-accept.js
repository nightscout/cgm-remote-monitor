var mime = require('mime')
var url = require('url')

module.exports = function (formats) {
  if (!Array.isArray(formats))
    throw new TypeError('Formats must be an array.')

  var getType = Object.create(null)

  formats.forEach(function (format) {
    if (!/^\w+$/.test(format))
      throw new TypeError('Invalid format - must be a word.')

    var type = getType[format] = mime.getType(format)
    if (!type || type === 'application/octet-stream')
      throw new Error('Invalid format.')
  })

  var regexp = new RegExp('\\.(' + formats.join('|') + ')$', 'i')

  return function (req, res, next) {
    var match = req.path.match(regexp)
    if (!match)
      return next()
    var type = getType[match[1]]
    if (!type)
      return next()

    req.extToAccept = {
      url: req.url,
      accept: req.headers.accept
    }

    req.headers.accept = type
    var parsed = url.parse(req.url)
    parsed.pathname = req.path.replace(regexp, '')
    req.url = url.format(parsed)

    next()
  }
}