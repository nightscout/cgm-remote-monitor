var drawerIsOpen = false;

function openDrawer()  {
	$("#container").animate({marginLeft: "-200px"}, 300);
	$("#drawer").css("display", "block");
	$("#drawer").animate({right: "0"}, 300);
	drawerIsOpen = true;
}
function closeDrawer(callback) {
	$("#container").animate({marginLeft: "0px"}, 300, callback);
	$("#drawer").animate({right: "-200px"}, 300, function() {
		$("#drawer").css("display", "none");
	});
	drawerIsOpen = false;
}

function openToolbar() {
	$("#showToolbar").fadeOut(200, function() {
		$("#toolbar").animate({marginTop: "-0px"}, 200);
	});
}
function closeToolbar() {
	$("#toolbar").animate({marginTop: "-44px"}, 200, function() {
		$("#showToolbar").fadeIn().css("display", "block");
	});
}

$("#drawerToggle").click(function(event) {
	if(drawerIsOpen) {
		closeDrawer();
		drawerIsOpen = false;
	}  else {
		openDrawer();
		drawerIsOpen = true;
	}
	event.preventDefault();
});

$("#hideToolbar").click(function(event) {
	if (drawerIsOpen) {
		closeDrawer(function() {
			closeToolbar();
		});
	} else {
		closeToolbar();
	}
	event.preventDefault();
});

$("#showToolbar").find("a").click(function(event) {
	openToolbar();
	event.preventDefault();
});

function isTouch() {
	try{ document.createEvent("TouchEvent"); return true; }
	catch(e){ return false; }
}
var notTouchScreen = (!isTouch());

// Tooltips can remain in the way on touch screens.
if (notTouchScreen) {
	$('.tip').tipsy();
} else {
	// Drawer info tips should be displayed on touchscreens.
	$('#drawer').find(".tip").tipsy();
}
$.fn.tipsy.defaults = {
	fade: true,
	gravity: "n",
	opacity: 0.75
}

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
		var url = window.location.href;
		url = url.replace(/#$/, ""); // stops # in url from stopping form submission
		window.location = url;
	});

	function storeInBrowser(json) {
		if (json.units) storage.set("units", json.units);
		if (json.nightMode == true) {
			storage.set("nightMode", true)
		} else {
			storage.set("nightMode", false)
		}
		event.preventDefault();
	}

	function storeOnServer(json) {
		alert("TO DO: add storeOnServer() logic.\n" + json.alertHigh + "\n" + json.alertLow);
		// reference: http://code.tutsplus.com/tutorials/submit-a-form-without-page-refresh-using-jquery--net-59
	}

	$.ajax('/api/v1/status.json', { success: function (xhr) {
		$('.appName').text(xhr.name);
		$('.version').text(xhr.version);
	}});
});
