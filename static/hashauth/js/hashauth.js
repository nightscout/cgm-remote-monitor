(function () {
  var translate = Nightscout.language.translate;

	var apisecret = '';
	var storeapisecret = false;
	var	apisecrethash = null;
	var authenticated = false;
	
	function verifyAuthentication(next) {
		var xhr = new XMLHttpRequest();
		xhr.open('GET', '/api/v1/verifyauth', true);
		xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
		xhr.setRequestHeader('api-secret', apisecrethash);
		xhr.onload = function () {
//console.log(xhr);
			if (xhr.statusText=='OK') {
				authenticated = true;
				console.log('Authentication passed.');
				next(true);
			} else {
				console.log('Authentication failed.');
				removeAuthentication();
				next(false);
			}
		}
		xhr.send();
	}
	function initAuthentication() {
		apisecrethash = localStorage.getItem('apisecrethash');
		verifyAuthentication(function () {
			$('#authentication_placeholder').html(inlineCode());
		});
	}
	
	function removeAuthentication(event) {
		localStorage.removeItem('apisecrethash');
		apisecret = null;
		apisecrethash = null;
		authenticated = false;
		$('#authentication_placeholder').html(inlineCode());
		if (event) event.preventDefault();
		return false;
	}
	
	function requestAuthentication(event) {
		$( "#requestauthenticationdialog" ).dialog({
			  width: 500
			, height: 240
			,  buttons: [
				{ text: translate("Update"),
					click: function() {
						apisecret = $('#apisecret').val();
						storeapisecret = $('#storeapisecret').is(':checked');
						if (apisecret.length < 12) {
							alert(translate('Too short API secret'));
							$( this ).dialog( "close" );
							return false;
						} else {
							var shaObj = new jsSHA(apisecret, "TEXT");
							apisecrethash = shaObj.getHash("SHA-1", "HEX");
							var dialog = this;
							verifyAuthentication( function(isok) {
								if (isok) {
									if (storeapisecret) {
										localStorage.setItem('apisecrethash',apisecrethash);
									}
									$('#authentication_placeholder').html(inlineCode());
								} else {
									alert(translate('Wrong API secret'));
								}
								$( dialog ).dialog( "close" );
							});
							return false;
						}
					}
						
				},
				{ text: translate("Remove"),
					click: function () {
						$( this ).dialog( "close" );
						removeAuthentication();
					}
				}
			  ]
			, open   : function(ev, ui) {
				$('#apisecret').val('');
				$('#apisecret').focus();
			}

		});
		if (event) event.preventDefault();
		return false;
	}
	
	function inlineCode() {
		html =
			'<div id="requestauthenticationdialog" style="display:none" title="'+translate('Device authentication')+'">'+
				'<label for="apisecret">'+translate('Your API secret')+': </label>'+
				'<input type="password" id="apisecret" size="10" />'+
				'<br>'+
				'<input type="checkbox" id="storeapisecret" />  '+translate('Store hash on this computer (Use only on private computers)')+
				'<div id="apisecrethash">'+
				(apisecrethash ? translate('Hash') + ' ' + apisecrethash: '')+
				'</div>'+
			'</div>'+
			'<div id="authorizationstatus">'+
				(isAuthenticated() ? 
					translate('Device authenticated') + ' <a href="#" onclick="Nightscout.auth.removeAuthentication()">(' + translate('Remove') + ')</a>'
					:
					translate('Device not authenticated') + ' <a href="#" onclick="Nightscout.auth.requestAuthentication()">(' + translate('Authenticate') + ')</a>'
				)+
			'</div>';

		return html;
	}
	
	function hash() {
		return apisecrethash;
	}
	
	function isAuthenticated() {
		return authenticated;
	}
	
	initAuthentication();

	Nightscout.auth = Nightscout.auth || {};
	Nightscout.auth.isAuthenticated = isAuthenticated;
	Nightscout.auth.removeAuthentication = removeAuthentication;
	Nightscout.auth.requestAuthentication = requestAuthentication;
	Nightscout.auth.hash = hash;
	Nightscout.auth.inlineCode = inlineCode;

})();

