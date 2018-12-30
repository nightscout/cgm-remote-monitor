'use strict';

var fs = require('fs');
var IBFRecordReader = require('ibf-file-reader/dist/IBFRecord/IBFRecordReader');
var LogRecordParser = require('ibf-file-reader/dist/LogRecord/LogRecordParser');
var LogRecord = require('ibf-file-reader/dist/LogRecord/LogRecord');

function init(env, ctx) {
  var omnipoduploader = {};

  omnipoduploader.handleUpload = function handleUpload(req, res) {
    // user input is UTC+tzOffset hours
    var uploadOffset = req.body.tzOffset;

    var filepath = 'uploads/' + req.files.idf[0].filename;
    readFile(filepath, function (fileErr, logRecord) {
      if (fileErr) {
        console.log(fileErr);
      } else {
        let treatment = logRecordToTreatment(logRecord, -60 * uploadOffset);
        if (treatment) {
          ctx.treatments.create(treatment, function logCreateError(err) {
            if (err) {
              console.log(err);
            }
          });
        }
      }
    });

    fs.unlink(filepath, function logUnlinkError(err) {
      if (err) {
        console.log(err);
      }
    });

    res.status(204).end();
  }

  return omnipoduploader;
}

/* Converts a log record as read from an IBF file into a treatment appropriate for storage. */
function logRecordToTreatment(obj, uploadOffsetMinutes) {

  if (obj.logType == LogRecord.LogRecordType.HISTORY) {
    // Record timestamp is 'PDM local time labeled as UTC'.  Convert using offset.
    var treatmentTimestamp = new Date(obj.timestamp.getTime() + (uploadOffsetMinutes * 60 * 1000));

    var treatment = {
      'created_at': treatmentTimestamp.toISOString(),
      'enteredBy': 'ibf-upload'
    };

    switch (obj.historyLogRecordType) {
      case LogRecord.HistoryLogRecordType.CARB:
        treatment['eventType'] = 'Carbs';
        treatment['carbs'] = obj.carbs;
        return treatment;
      case LogRecord.HistoryLogRecordType.BOLUS:
        treatment['eventType'] = 'Bolus';
        treatment['insulin'] = obj.units;
        return treatment;
    }
  }

  return null;
}

function readFile(file, callback) {
  fs.readFile(file, (err, buffer) => {
    if (err != null) {
      callback(err);
      return;
    }

    let record;
    while (true) {
      [record, buffer] = IBFRecordReader.readIBFRecord(buffer);

      if (record == null || buffer.length == 0) {
        break;
      }
      let [err, parsed] = LogRecordParser.parseLogRecord(record);
      if (err) {
        callback(err);
      } else if (callback) {
        callback(null, parsed);
      }
    }
  });
}

module.exports = init
