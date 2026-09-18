# MIME types maintenance review (M09)

Upgrade Nightscout's direct `mime-types` from 2.1.35 to 3.0.2, the release
already used by Express 5, send, type-is and development middleware. Keep the
maintained database rather than implementing broad extension lookup locally.
The [upstream major release](https://github.com/jshttp/mime-types/releases/tag/v3.0.0)
changes conflict resolution and requires Node >=18, within our supported floors.

## API compatibility

Version 3 maps `js` to `text/javascript`, while Nightscout's v1 status route
explicitly negotiates `application/javascript`. The v1 extension middleware
retains that established mapping. Static-file MIME behavior already uses v3
through Express and does not change. V3's supported JSON/CSV/XML aliases remain
unchanged; unsupported JavaScript requests still return 406.

Comparing the 1,180 old lookup extensions finds 12 changed mappings: es, js,
mjs, xfdf, fdf, prc, sql, wav, aac, hsj2, mts and jpgm. None changes V3's
supported response formats. None of the 59 added extensions maps to its accepted
application/json, application/xml or text/csv types. The existing negotiation
test retains every configured v1 mapping and extends V3 rejection checks to
all changed mappings. The actual status API test now awaits request errors,
checks both extension and explicit Accept negotiation twice, and parses the
returned settings payload.

## Installed dependency tradeoff

The update consolidates five `mime-types` installations into three. Version
2.1.35 remains required by accepts 1.x and form-data, with separate copies of
its 1.52.0 MIME database. Their majors are not forced through an override.

Summing each package's own regular files, excluding nested node_modules to
avoid double counting, across mime-types and mime-db:

| Scope | Before | After | Change |
| --- | ---: | ---: | ---: |
| All installed files | 540,861 bytes | 696,059 bytes | +155,198 bytes |
| Production installed files | 517,990 bytes | 696,059 bytes | +178,069 bytes |

Accept this as a maintenance/alignment upgrade, not a package-size or memory
optimization. The older dependency branches can be reviewed with their parents.
No server RAM or browser-size saving is claimed. Full CI and CodeQL remain
required before merge into the modernization branch.
