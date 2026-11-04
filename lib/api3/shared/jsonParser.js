'use strict';

const express = require('express');
const apiConst = require('../const.json');

module.exports = function jsonParser () {
  return [express.json({ limit: 1048576 * 50 }), function errorHandler (err, req, res, next) {
    console.error(err);
    res.status(apiConst.HTTP.INTERNAL_ERROR).json({
      status: apiConst.HTTP.INTERNAL_ERROR,
      message: apiConst.MSG.HTTP_500_INTERNAL_ERROR
    });
    if (next) {
      // Express identifies an error handler by its four parameters.
    }
  }];
};
