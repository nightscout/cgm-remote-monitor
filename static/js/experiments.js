$(function() {
	if (querystring.experiments) {
		$(".experiments").show();
		if (!querystring.drawer) {
			$("#drawerToggle").click();
		}
	} else {
		$(".experiments").hide();
	}

	$(".glyphToggle").on("click", function(){
		var newGlyph = $(this).find("i").attr("class");
		$("#drawerToggle").find("i").prop("class", newGlyph);
		event.preventDefault();
	});

	$(".iconToggle").on("click", function(){
		var newIcon = $(this).find("img").attr("src");
		$("#favicon").prop("href", newIcon);
		event.preventDefault();
	});

	$(".toolbarIconToggle").on("click", function(){
		var newIcon = $(this).find("img").attr("src");
		$("#toolbar").css({'background-image':'url('+newIcon+')'});
		event.preventDefault();
	});
});
