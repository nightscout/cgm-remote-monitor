'use strict';

const apiConst = require('../const.json')
  , mime = require('mime')
  , url = require('url')
  , opTools = require('./operationTools')
  , EasyXml = require('easyxml')
  , csvStringify = require('csv-stringify')
  ;

const SAFE_XML_ELEMENT_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;


/**
 * Convert persisted object keys to safe XML element names before handing the
 * document to easyxml. Ordinary Nightscout field names are retained exactly;
 * unusual names are encoded and any resulting collisions are disambiguated.
 */
function normalizeXmlElementNames (value) {
  if (value === null || typeof value !== 'object' || value instanceof Date
    || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
    || ArrayBuffer.isView(value)
    || typeof value.toJSON === 'function') {
    return value;
  }

  const keys = Object.keys(value)
    , result = Array.isArray(value) ? [] : Object.create(null)
    , reservedNames = new Set(keys.filter(function isReservedName (key) {
      return SAFE_XML_ELEMENT_NAME.test(key);
    }))
    , usedNames = new Set()
    ;

  keys.forEach(function normalizeKey (key) {
    // Preserve array indexes so easyxml can retain its existing item naming.
    const isArrayIndex = Array.isArray(value) && /^(0|[1-9][0-9]*)$/.test(key);
    let normalizedKey = key;

    if (!isArrayIndex && !SAFE_XML_ELEMENT_NAME.test(key)) {
      const encodedName = `_encoded_${Buffer.from(key, 'utf8').toString('base64url')}`;
      normalizedKey = encodedName;

      let suffix = 2;
      while (reservedNames.has(normalizedKey) || usedNames.has(normalizedKey)) {
        normalizedKey = `${encodedName}_${suffix}`;
        suffix += 1;
      }
    }

    usedNames.add(normalizedKey);
    result[normalizedKey] = normalizeXmlElementNames(value[key]);
  });

  return result;
}


/**
 * Middleware that converts url's extension to Accept HTTP request header
 * @param {Object} req
 * @param {Object} res
 * @param {Function} next
 */
function extension2accept (req, res, next) {

  const pathSplit = req.path.split('.');

  if (pathSplit.length < 2)
    return next();

  const pathBase = pathSplit[0]
    , extension = pathSplit.slice(1).join('.');

  if (!extension)
    return next();

  const mimeType = mime.getType(extension);
  if (!mimeType)
    return opTools.sendJSONStatus(res, apiConst.HTTP.NOT_ACCEPTABLE, apiConst.MSG.HTTP_406_UNSUPPORTED_FORMAT);

  req.extToAccept = {
    url: req.url,
    accept: req.headers.accept
  };

  req.headers.accept = mimeType;
  const parsed = url.parse(req.url);
  parsed.pathname = pathBase;
  req.url = url.format(parsed);

  next();
}


/**
 * Sends data to output using the client's desired format
 * @param {Object} res
 * @param {any} data
 */
function render (res, data) {
  res.format({
    'json': () => renderJson(res, data),
    'csv': () => renderCsv(res, data),
    'xml': () => renderXml(res, data),
    'default': () =>
      opTools.sendJSONStatus(res, apiConst.HTTP.NOT_ACCEPTABLE, apiConst.MSG.HTTP_406_UNSUPPORTED_FORMAT)
  });
}


/**
 * Format data to output as JSON
 * @param {Object} res
 * @param {any} data
 */
function renderJson (res, data) {
  res.send({
    status: apiConst.HTTP.OK,
    result: data
  });
}


/**
 * Format data to output as .csv
 * @param {Object} res
 * @param {any} data
 */
function renderCsv (res, data) {
  const csvSource = Array.isArray(data) ? data : [data];
  csvStringify(csvSource, {
      header: true
    },
    function csvStringified (err, output) {
      res.send(output);
    });
}


/**
 * Format data to output as .xml
 * @param {Object} res
 * @param {any} data
 */
function renderXml (res, data) {
  const serializer = new EasyXml({
    rootElement: 'item',
    dateFormat: 'ISO',
    manifest: true,
    // Persisted document keys are data, not serializer instructions. Keep the
    // output structure independent from underscore-prefixed field names.
    attributePrefix: false
  });
  res.send(serializer.render(normalizeXmlElementNames(data)));
}


module.exports = {
  extension2accept,
  render
};
