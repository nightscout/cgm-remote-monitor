# XML test parser review (M09)

Retain xml2js 0.5.0. The latest published release checked on 2026-09-06 is
0.6.2, but it fails a reproduced data-preservation contract on both supported
Node floors. No manifest or lockfile change is accepted in this review.

The parser is used only by API3 XML renderer tests and the Mocha xunit reporter
regression. It is not a production XML-input parser. Node has no built-in XML
DOM parser suitable for these backend tests. Reimplementing XML parsing locally
would weaken an independent validation tool and add maintenance complexity.

For this fixture:

```xml
<root><constructor>ordinary</constructor><__proto__><polluted>fixture</polluted></__proto__></root>
```

With `explicitArray: false`, 0.5.0 returns the intended scalar `constructor` and
nested `__proto__` document in objects with null prototypes. Version 0.6.2 returns
arrays containing the inherited `Object` constructor and `Object.prototype`
before the XML values. This reproduces on Node 22.23.2 and 24.20.0. Updating
its SAX consumer to 1.6.1 does not fix the xml2js object-building behavior.
The fixture does **not** modify Object.prototype; do not describe this finding
as a demonstrated global prototype-pollution exploit.

The [upstream report #719](https://github.com/Leonidas-from-XIV/node-xml2js/issues/719)
describes the inherited-property check; the
[0.5.0...0.6.2 source changes](https://github.com/Leonidas-from-XIV/node-xml2js/compare/0.5.0...0.6.2)
explain the change from null-prototype objects to defineProperty-based writes.
Although that report is closed, the published 0.6.2 package still reproduces the
behavior. A closed issue or a clean advisory scan is not evidence of a fixed
published consumer.

New regression tests preserve renderer-style scalar/array/attribute values,
Unicode and escaping; require prototype-named elements to remain writable own
data without inherited values; check constructor attributes; and verify parser
recovery after malformed XML and unknown/external entity references. Existing
API3 renderer/security tests and xunit XML round-trip coverage remain.
The tests intentionally preserve null-prototype output. They must not be relaxed
solely to accept an upgrade that inserts inherited objects/functions into data.

The existing SAX parser also omits a `__proto__` attribute in both reviewed
xml2js versions; this review does not claim that pre-existing behavior is fixed.
The new prototype-attribute test covers `constructor`, which both the renderer
oracle and retained parser can represent. ElementTree's production SAX pin is
unchanged; no override is forced across that separate consumer.

Reconsider a later published fix or a separately evaluated maintained parser
when it satisfies these contracts and the actual renderer tests. No package,
server-memory, browser, or user-facing configuration change is claimed here.
M09's other dependency and override reviews remain open.
