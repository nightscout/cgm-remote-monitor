var drawerIsOpen = false;
var browserStorage = $.localStorage;
var defaultSettings = {
	"units": "mg/dl",
	"nightMode": false
}

var app = {};
$.ajax("/api/v1/status.json", {
	success: function (xhr) {
		app = {
			"name": xhr.name,
			"version": xhr.version,
			"apiEnabled": xhr.apiEnabled
		}
	}
}).done(function() {
	$(".appName").text(app.name);
	$(".version").text(app.version);
	if (app.apiEnabled) {
		$(".serverSettings").show();
	}
});


function getBrowserSettings(storage) {
	var json = {
		"units": storage.get("units"),
		"nightMode": storage.get("nightMode")
	};

	// Default browser units to server units if undefined.
	json.units = setDefault(json.units, serverSettings.units);
	console.log("browserSettings.units: " + json.units);
	if (json.units == "mmol") {
		$("#mmol-browser").prop("checked", true);
	} else {
		$("#mgdl-browser").prop("checked", true);
	}

	json.nightMode = setDefault(json.nightMode, defaultSettings.nightMode);
	$("#nightmode-browser").prop("checked", json.nightMode);

	return json;
}
function getServerSettings() {
	var json = {
		"units": Object()
	};

	json.units = setDefault(json.units, defaultSettings.units);
	console.log("serverSettings.units: " + json.units);
	if (json.units == "mmol") {
		$("#mmol-server").prop("checked", true);
	} else {
		$("#mgdl-server").prop("checked", true);
	}

	return json;
}
function setDefault(variable, defaultValue) {
	if (typeof(variable) === "object") {
		return defaultValue;
	}
	return variable;
}
function jsonIsNotEmpty(json) {
	var jsonAsString = JSON.stringify(json);
	jsonAsString.replace(/\s/g, "");
	return (jsonAsString != "{}")
}
function storeInBrowser(json, storage) {
	if (json.units) storage.set("units", json.units);
	if (json.nightMode == true) {
		storage.set("nightMode", true)
	} else {
		storage.set("nightMode", false)
	}
	event.preventDefault();
}
function storeOnServer(json) {
	if (jsonIsNotEmpty(json)) {
		alert("TO DO: add storeOnServer() logic.");
		// reference: http://code.tutsplus.com/tutorials/submit-a-form-without-page-refresh-using-jquery--net-59
		//var dataString = "name="+ name + "&email=" + email + "&phone=" + phone;
		//alert (dataString);return false;
		/* $.ajax({
		  type: "POST",
		  url: "/api/v1/settings",
		  data: json
		});
		*/
	}
}


function getQueryParms() {
	params = {};
	location.search.substr(1).split("&").forEach(function(item) {
		params[item.split("=")[0]] = item.split("=")[1]
	});
	return params;
}

function isTouch() {
	try{ document.createEvent("TouchEvent"); return true; }
	catch(e){ return false; }
}


function closeDrawer(callback) {
	$("#container").animate({marginLeft: "0px"}, 300, callback);
	$("#drawer").animate({right: "-200px"}, 300, function() {
		$("#drawer").css("display", "none");
	});
	drawerIsOpen = false;
}
function openDrawer()  {
	drawerIsOpen = true;
	$("#container").animate({marginLeft: "-200px"}, 300);
	$("#drawer").css("display", "block");
	$("#drawer").animate({right: "0"}, 300);
}


function closeNotification() {
	$("#notification").hide();
	$("#notification").find("span").html("");
}
function showNotification(note)  {
	$("#notification").hide();
	$("#notification").find("span").html(note);
	$("#notification").css("left", "calc(50% - " + ($("#notification").width() / 2) + "px)");
	$("#notification").show();
}


function closeToolbar() {
	$("#toolbar").animate({marginTop: "-44px"}, 200, function() {
		$("#showToolbar").fadeIn().css("display", "block");
	});
}
function openToolbar() {
	$("#showToolbar").fadeOut(200, function() {
		$("#toolbar").animate({marginTop: "-0px"}, 200);
	});
}


var querystring = getQueryParms();
// var serverSettings = getServerSettings();
var browserSettings = getBrowserSettings(browserStorage);


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

$("#notification").click(function(event) {
	closeNotification();
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

$("input#save").click(function() {
	storeInBrowser({
		"units": $("input:radio[name=units-browser]:checked").val(),
		"nightMode": $("#nightmode-browser").prop("checked")
	}, browserStorage);

	storeOnServer({
		//"units": $("input:radio[name=units-server]:checked").val()
	});

	event.preventDefault();

	// reload for changes to take effect
	// -- strip '#' so form submission does not fail
	var url = window.location.href;
	url = url.replace(/#$/, "");
	window.location = url;
});


$(function() {
	// Tooltips can remain in the way on touch screens.
	var notTouchScreen = (!isTouch());
	if (notTouchScreen) {
		$(".tip").tipsy();
	} else {
		// Drawer info tips should be displayed on touchscreens.
		$("#drawer").find(".tip").tipsy();
	}
	$.fn.tipsy.defaults = {
		fade: true,
		gravity: "n",
		opacity: 0.75
	}

	if (querystring.notify) {
		showNotification(querystring.notify.replace("+", " "));
	}

	if (querystring.drawer) {
		openDrawer();
	} else {
		// drawer=true cancels out toolbar=false
		if (querystring.toolbar == "false") {
			closeToolbar();
		}
	}
});
