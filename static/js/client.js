'use strict';

$(document).on('online', function() {
	console.log('Application got online event, reloading');
	window.location.reload();
});

$(document).ready(function() {
	console.log('Application got ready event');
	window.Nightscout.client.init();
});