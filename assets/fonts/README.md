How to upgrade icons in icon-fonts on Nightscout
================================================

This guide is fol developers regarding how to add new icon to Nightscout.

Nightscout use icon fonts to render icons. Each icon is glyph (like - letter, or more like emoji character) inside custom made font file.
That way we have nice, vector icons, that are small, scalable, looks good on each platform, and are easy to embed inside CSS.

To extend existing icon set.:

1. Prepare minimalist, black & white icon in SVG tool of choice, and optimize it (you can use Inkscape) to be small in size and render good at small sizes.
2. Use https://icomoon.io/app and import accompanied JSON project file (`Nightscout Plugin Icons.json`)
3. Add SVG as new glyph. Remember to take care to set proper character code and CSS name
4. Save new version of JSON project file and store in this folder
5. Generate font, download zip file and unpack it to get `fonts/pluginicons.svg` and `fonts/pluginicons.woff`
6. Update `statc/css/main.css` file
   * In section of `@font-face` with `font-family: 'pluginicons'`
     * update part after `data:application/font-woff;charset=utf-8;base64,` with Base64-encoded content of just generated `pluginicons.woff` font
     * update part after `data:application/font-svg;charset=utf-8;base64,` with Base64-encoded content of just generated `pluginicons.svg` font
   * copy/update all entries `.plugicon-****:before { content: "****"; }` from generated font `style.css` into `statc/css/main.css`
7. Do not forget to update `Nightscout Plugin Icons.json` in this repo (´download updated project from icomoon.io)
   
Hints
-----

* You can find many useful online tools to encode file into Base64, like: https://base64.guru/converter/encode/file
* Do not split Base64 output - it should be one LONG line
* Since update process is **manual** and generated fonts & updated CSS sections are **binary** - try to avoid **git merge conflicts** by speaking with other developers if you plan to add new icon
* When in doubt - check `git log` and reach last contributor for guidelines :)
