var drawerIsOpen = false;
var browserStorage = $.localStorage;
var defaultSettings = {
	"units": "mg/dl",
	"alarmHigh": true,
	"alarmLow": true,
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
		"alarmHigh": storage.get("alarmHigh"),
		"alarmLow": storage.get("alarmLow"),
		"nightMode": storage.get("nightMode"),
		"customTitle": storage.get("customTitle")
	};

	// Default browser units to server units if undefined.
	json.units = setDefault(json.units, serverSettings.units);
	if (json.units == "mmol") {
		$("#mmol-browser").prop("checked", true);
	} else {
		$("#mgdl-browser").prop("checked", true);
	}

	json.alarmHigh = setDefault(json.alarmHigh, defaultSettings.alarmHigh);
	$("#alarmhigh-browser").prop("checked", json.alarmHigh);
	json.alarmLow = setDefault(json.alarmLow, defaultSettings.alarmLow);
	$("#alarmlow-browser").prop("checked", json.alarmLow);

	json.nightMode = setDefault(json.nightMode, defaultSettings.nightMode);
	$("#nightmode-browser").prop("checked", json.nightMode);

	if (json.customTitle) {
		$("h1.customTitle").html(json.customTitle);
		$("input#customTitle").prop("value", json.customTitle);
		document.title = "Nightscout: " + json.customTitle;
	}

	return json;
}
function getServerSettings() {
	var json = {
		"units": Object()
	};

	json.units = setDefault(json.units, defaultSettings.units);
	//console.log("serverSettings.units: " + json.units);
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
	if (json.alarmHigh == true) {
		storage.set("alarmHigh", true)
	} else {
		storage.set("alarmHigh", false)
	}
	if (json.alarmLow == true) {
		storage.set("alarmLow", true)
	} else {
		storage.set("alarmLow", false)
	}
	if (json.nightMode == true) {
		storage.set("nightMode", true)
	} else {
		storage.set("nightMode", false)
	}
	if (json.customTitle) storage.set("customTitle", json.customTitle);
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
	if (location.search) {
		location.search.substr(1).split("&").forEach(function(item) {
			params[item.split("=")[0]] = item.split("=")[1].replace(/[_\+]/g, " ");
		});
	}
	return params;
}

function isTouch() {
	try{ document.createEvent("TouchEvent"); return true; }
	catch(e){ return false; }
}


function closeDrawer(callback) {
	$("#container").animate({marginLeft: "0px"}, 300, callback);
	$("#chartContainer").animate({marginLeft: "0px"}, 300);
	$("#drawer").animate({right: "-200px"}, 300, function() {
		$("#drawer").css("display", "none");
	});
	drawerIsOpen = false;
}
function openDrawer()  {
	drawerIsOpen = true;
	$("#container").animate({marginLeft: "-200px"}, 300);
	$("#chartContainer").animate({marginLeft: "-200px"}, 300);
	$("#drawer").css("display", "block");
	$("#drawer").animate({right: "0"}, 300);
}


function closeNotification() {
	var notify = $("#notification");
	notify.hide();
	notify.find("span").html("");
}
function showNotification(note, type)  {
	var notify = $("#notification");
	notify.hide();

	// Notification types: "info", "warn", "success", "urgent".
	// - default: "urgent"
	notify.removeClass("info warn urgent");
	notify.addClass(type ? type : "urgent");

	notify.find("span").html(note);
	notify.css("left", "calc(50% - " + ($("#notification").width() / 2) + "px)");
	notify.show();
}


function closeToolbar() {
	stretchStatusForToolbar("close");

	$("#showToolbar").css({top: "44px"});
	$("#showToolbar").fadeIn(50, function() {
		$("#showToolbar").animate({top: 0}, 200);
		$("#toolbar").animate({marginTop: "-44px"}, 200);
	});
}
function openToolbar() {
	$("#showToolbar").css({top: 0});
	$("#showToolbar").animate({top: "44px"}, 200).fadeOut(200);
	$("#toolbar").animate({marginTop: "0px"}, 200);

	stretchStatusForToolbar("open");
}
function stretchStatusForToolbar(toolbarState){
	// closed = up
	if (toolbarState == "close") {
		$(".status").addClass("toolbarClosed");
	}

	// open = down
	if (toolbarState == "open") {
		$(".status").removeClass("toolbarClosed");
	}
}


var querystring = getQueryParms();
// var serverSettings = getServerSettings();
var browserSettings = getBrowserSettings(browserStorage);

function Dropdown(el) {
	this.ddmenuitem = 0;

	this.$el = $(el);
	var that = this;

	$(document).click(function() { that.close(); });
}
Dropdown.prototype.close = function () {
	if (this.ddmenuitem) {
		this.ddmenuitem.css('visibility', 'hidden');
		this.ddmenuitem = 0;
	}
};
Dropdown.prototype.open = function (e) {
	this.close();
	this.ddmenuitem = $(this.$el).css('visibility', 'visible');
	e.stopPropagation();
};


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
		"alarmHigh": $("#alarmhigh-browser").prop("checked"),
		"alarmLow": $("#alarmlow-browser").prop("checked"),
		"nightMode": $("#nightmode-browser").prop("checked"),
		"customTitle": $("input#customTitle").prop("value")
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
		showNotification(querystring.notify, querystring.notifytype);
	}

	if (querystring.drawer) {
		openDrawer();
	} else {
		// drawer=true cancels out toolbar=false
		if (querystring.toolbar == "false") {
			closeToolbar();
		}
	}

	//setTimeout(function(){$("#loader").fadeOut(1500)}, 2000);
	$("#loader").fadeOut(1500);
});
