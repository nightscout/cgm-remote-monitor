/**
 * Material floating button
 * By: Nobita
 * Repo and docs: https://github.com/nobitagit/material-floating-button
 *
 * License: MIT
 */

 // build script hook - don't remove
 ;(function ( window, document, undefined ) {
 

  'use strict';

  /**
   * Some defaults
   */
  var clickOpt = 'click',
      hoverOpt = 'hover',
      toggleMethod = 'data-mfb-toggle',
      menuState = 'data-mfb-state',
      isOpen = 'open',
      isClosed = 'closed',
      mainButtonClass = 'mfb-component__button--main';

  /**
   * Internal references
   */
  var elemsToClick,
      elemsToHover,
      mainButton,
      target,
      currentState;

  /**
   * For every menu we need to get the main button and attach the appropriate evt.
   */
  function attachEvt( elems, evt ){
    for( var i = 0, len = elems.length; i < len; i++ ){
      mainButton = elems[i].querySelector('.' + mainButtonClass);
      mainButton.addEventListener( evt , toggleButton, false);
    }
  }

  /**
   * Remove the hover option, set a click toggle and a default,
   * initial state of 'closed' to menu that's been targeted.
   */
  function replaceAttrs( elems ){
    for( var i = 0, len = elems.length; i < len; i++ ){
      elems[i].setAttribute( toggleMethod, clickOpt );
      elems[i].setAttribute( menuState, isClosed );
    }
  }

  function getElemsByToggleMethod( selector ){
    return document.querySelectorAll('[' + toggleMethod + '="' + selector + '"]');
  }

  /**
   * The open/close action is performed by toggling an attribute
   * on the menu main element.
   *
   * First, check if the target is the menu itself. If it's a child
   * keep walking up the tree until we found the main element
   * where we can toggle the state.
   */
  function toggleButton( evt ){

    target = evt.target;
    while ( target && !target.getAttribute( toggleMethod ) ){
      target = target.parentNode;
      if(!target) { return; }
    }

    currentState = target.getAttribute( menuState ) === isOpen ? isClosed : isOpen;

    target.setAttribute(menuState, currentState);

  }

  /**
   * On touch enabled devices we assume that no hover state is possible.
   * So, we get the menu with hover action configured and we set it up
   * in order to make it usable with tap/click.
   **/
  if ( window.Modernizr && Modernizr.touch ){
    elemsToHover = getElemsByToggleMethod( hoverOpt );
    replaceAttrs( elemsToHover );
  }

  elemsToClick = getElemsByToggleMethod( clickOpt );

  attachEvt( elemsToClick, 'click' );

// build script hook - don't remove
})( window, document );

