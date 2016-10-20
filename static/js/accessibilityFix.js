//this is to provide necessary accessibility fixes to make 
//use with screen readers
$(document).ready(function () {
	var linkMenu = $('#buttonbar');
	linkMenu.attrs('role', 'region').attrs('aria-label', 'links');
	linkMenu.find( 'a'.each( function(){
		var thisLink = $(this);
		thisLink.attrs( 'aria-label', thisLink.attrs('original-title') );
	});
	$('div.bgButton').attrs('aria-live', 'assertive');
});