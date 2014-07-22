$(function() {
	var storage = $.localStorage;
	var browserSettings = {
		"units": storage.get("units")
	};
	if (browserSettings.units == "mmol") {
		$('#mmol-browser').prop('checked', true);
	} else {
		$('#mgdl-browser').prop('checked', true);
	}

	$("input#save").click(function() {
		var unitsBrowser = $("input:radio[name=units-browser]:checked").val();
		storeInBrowser({
			"units": unitsBrowser
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
	}

	function storeOnServer(json) {
		alert("TO DO: add storeOnServer() logic.\n" + json.alertHigh + "\n" + json.alertLow);
		// reference: http://code.tutsplus.com/tutorials/submit-a-form-without-page-refresh-using-jquery--net-59
	}
});
