$(function() {
	var storage = $.localStorage;
	var browserSettings = {
		"units": storage.get("units"),
		"nightMode": storage.get("nightMode")
	};
	if (browserSettings.units == "mmol") {
		$('#mmol-browser').prop('checked', true);
	} else {
		$('#mgdl-browser').prop('checked', true);
	}
	if (typeof(browserSettings.nightMode) === 'undefined' || browserSettings.nightMode == null) {
		browserSettings.nightMode = true;
	}
	$('#nightmode-browser').prop('checked', browserSettings.nightMode);

	$("input#save").click(function() {
		storeInBrowser({
			"units": $("input:radio[name=units-browser]:checked").val(),
			"nightMode": $('#nightmode-browser').prop('checked')
		});

		/* var formAction = $("#settings-form").attr("action");
		var alertHigh = $("input#alertHigh").val();
		var alertLow = $("input#alertLow").val();
		storeOnServer({
			"alertHigh": alertHigh,
			"alertLow": alertLow
		}); */

		event.preventDefault();

		// reload
		window.location = window.location;
	});

	function storeInBrowser(json) {
		if (json.units) storage.set("units", json.units);
		if (json.nightMode == true) {
			storage.set("nightMode", true)
		} else {
			storage.set("nightMode", false)
		}
	}

	function storeOnServer(json) {
		alert("TO DO: add storeOnServer() logic.\n" + json.alertHigh + "\n" + json.alertLow);
		// reference: http://code.tutsplus.com/tutorials/submit-a-form-without-page-refresh-using-jquery--net-59
	}
  $.ajax('/api/v1/status.json', { success: function (xhr) {
    $('.version').text(xhr.version);
  }});
});
