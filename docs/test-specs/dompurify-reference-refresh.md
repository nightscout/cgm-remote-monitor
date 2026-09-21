# DOMPurify reference refresh

DOMPurify 3.4.15 replaces 3.4.14 in development dependencies. It remains an
independent browser sanitizer comparator; production uses the local sanitizer.
Only the root development range and DOMPurify lock record change. This does not
remove a runtime package or claim server-memory savings.

The upstream release hardens XML/form clobbering and attribute/subtree cleanup:
https://github.com/cure53/DOMPurify/releases/tag/3.4.15

The existing 316-case DOMPurify and differential sanitizer corpus passes on
Node 22/Chromium and Node 24/WebKit. An additional real-browser regression passes
an XML-derived form with a mixed-case event attribute and a named child that
shadows attribute removal through DOMPurify's actual DOM-node API. It requires
that the event attribute cannot survive. The expanded DOMPurify file has 16
passing cases on both combinations. Hosted Firefox and full current-head CI
remain merge requirements. No production sanitizer or UI behavior is changed.
