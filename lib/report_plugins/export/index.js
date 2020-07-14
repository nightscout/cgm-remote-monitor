'use strict';

var _ = require('lodash');
var { ExportFormats, converterFactory } = require('./Converter');
var { processData } = require('./Processor');
var fileSaver = require('file-saver');


var exporter = {
	name: 'export'
	, label: 'Export'
	, pluginType: 'report'
};

function init() {
	return exporter;
}

module.exports = init;

exporter.html = function html(client) {
	var translate = client.translate;
	var ret =
		'<h2>' + translate('Export') + '</h2>' +
		'<b>' + translate('To export data, press SHOW while in this view') + '</b><br>';

	ret += '<div><label>Data format:';
	ret += '<select id="export-format">'
	_.forEach(ExportFormats, (format, key) => {
		ret += '<option value="' + format + '">' + key + '</option>';
	})
	ret += '</select></label></div>';

	ret += '<div><label>Use semicolons in CSV:<input type="checkbox" id="export-semicolon"></label></div>';

	return ret;
};

exporter.prepareHtml = function daytodayPrepareHtml() {
	$('#daytodaycharts').html('');
};

exporter.report = function report_daytoday(datastorage, sorteddaystoshow, options) {
	// var Nightscout = window.Nightscout;
	// var client = Nightscout.client;
	// var translate = client.translate;
	// var profile = client.sbx.data.profile;
	// var report_plugins = Nightscout.report_plugins;

	exporter.prepareHtml(sorteddaystoshow);

	console.log(datastorage, sorteddaystoshow, options);

	const { columns, data } = processData(datastorage, sorteddaystoshow)
	const converter = converterFactory($('#export-format').val(), columns, data, {
		semicolonSeparated: !!$('#export-semicolon').val()
	})
	const blob = converter.convert();
	const hostname = window.location.hostname;
	fileSaver.saveAs(blob, hostname + "." + converter.extension);
};
