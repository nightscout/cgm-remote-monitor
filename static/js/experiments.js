$(function() {
	if (querystring.experiments) {
		$(".experiments").show();
		$("#drawerToggle").click();
	} else {
		$(".experiments").hide();
	}

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
