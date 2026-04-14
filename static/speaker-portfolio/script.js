'use strict';

/* ==========================================================================
   Danny Recznik — Speaker Portfolio
   Responsibilities:
     1. Smooth scroll with fixed-nav offset
     2. Nav shadow + active link tracking
     3. Scroll-triggered fade-in animations (IntersectionObserver)
     4. Form validation + Formspree AJAX submission
     5. Footer copyright year
   ========================================================================== */

// --------------------------------------------------------------------------
// 1. Smooth Scroll with Nav Offset
// --------------------------------------------------------------------------

var NAV_HEIGHT = 64; // Must match --nav-height in styles.css

function scrollToSection(targetId) {
  var target = document.querySelector(targetId);
  if (!target) return;
  var top = target.getBoundingClientRect().top + window.scrollY - NAV_HEIGHT;
  window.scrollTo({ top: top, behavior: 'smooth' });
}

document.querySelectorAll('a[href^="#"]').forEach(function (link) {
  link.addEventListener('click', function (e) {
    var href = this.getAttribute('href');
    if (!href || href === '#') return;
    e.preventDefault();
    scrollToSection(href);
    history.pushState(null, '', href);
  });
});

// --------------------------------------------------------------------------
// 2. Nav Shadow + Active Link Tracking
// --------------------------------------------------------------------------

var nav = document.getElementById('site-nav');
var navLinks = document.querySelectorAll('.nav-link');
var sections = document.querySelectorAll('section[id]');

// Add scroll-shadow to nav when page is scrolled
window.addEventListener('scroll', function () {
  nav.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

// Track which section is in view and highlight matching nav link
var sectionObserver = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (entry.isIntersecting) {
      var id = entry.target.id;
      navLinks.forEach(function (link) {
        link.classList.toggle('active', link.getAttribute('href') === '#' + id);
      });
    }
  });
}, { threshold: 0.4 });

sections.forEach(function (section) {
  sectionObserver.observe(section);
});

// --------------------------------------------------------------------------
// 3. Scroll-Triggered Fade-In Animations (IntersectionObserver)
// --------------------------------------------------------------------------

var animObserver = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      animObserver.unobserve(entry.target); // animate once only
    }
  });
}, {
  threshold: 0.12,
  rootMargin: '0px 0px -40px 0px'
});

document.querySelectorAll('.animate-on-scroll').forEach(function (el) {
  animObserver.observe(el);
});

// --------------------------------------------------------------------------
// 4. Booking Form — Validation + Formspree AJAX Submission
// --------------------------------------------------------------------------

var form       = document.getElementById('booking-form');
var submitBtn  = document.getElementById('submit-btn');
var successMsg = document.getElementById('form-success');
var errorMsg   = document.getElementById('form-error-msg');

function validateField(inputId, errorId, message) {
  var input = document.getElementById(inputId);
  var error = document.getElementById(errorId);
  if (!input.value.trim()) {
    input.classList.add('invalid');
    error.textContent = message;
    return false;
  }
  input.classList.remove('invalid');
  error.textContent = '';
  return true;
}

// Clear validation state on user input
['name', 'contact', 'inquiry'].forEach(function (id) {
  var input   = document.getElementById(id);
  var errorEl = document.getElementById(id + '-error');
  input.addEventListener('input', function () {
    if (this.value.trim()) {
      this.classList.remove('invalid');
      errorEl.textContent = '';
    }
  });
});

form.addEventListener('submit', function (e) {
  e.preventDefault();

  // Client-side validation — all three fields are required
  var nameValid    = validateField('name',    'name-error',    'Please enter your name.');
  var contactValid = validateField('contact', 'contact-error', 'Please enter your email or phone number.');
  var inquiryValid = validateField('inquiry', 'inquiry-error', 'Please describe your event and goals.');

  if (!nameValid || !contactValid || !inquiryValid) return;

  // Check if Formspree ID has been configured
  var action = form.getAttribute('action') || '';
  if (action.indexOf('YOUR_FORM_ID') !== -1) {
    errorMsg.textContent =
      'The contact form is not yet configured. Please email djrecznik@gmail.com directly.';
    errorMsg.hidden = false;
    return;
  }

  // Submit state
  submitBtn.disabled    = true;
  submitBtn.textContent = 'Sending\u2026';
  successMsg.hidden     = true;
  errorMsg.hidden       = true;

  fetch(form.action, {
    method:  'POST',
    body:    new FormData(form),
    headers: { 'Accept': 'application/json' }
  })
  .then(function (response) {
    if (response.ok) {
      form.reset();
      successMsg.hidden = false;
      successMsg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      return response.json().catch(function () { return {}; }).then(function (data) {
        errorMsg.hidden = false;
        if (data.errors && data.errors.length) {
          errorMsg.textContent = data.errors.map(function (err) {
            return err.message;
          }).join('. ');
        }
      });
    }
  })
  .catch(function () {
    errorMsg.hidden = false;
  })
  .finally(function () {
    submitBtn.disabled    = false;
    submitBtn.textContent = 'Request Availability';
  });
});

// --------------------------------------------------------------------------
// 5. Footer — Dynamic Copyright Year
// --------------------------------------------------------------------------

var yearEl = document.getElementById('footer-year');
if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}
