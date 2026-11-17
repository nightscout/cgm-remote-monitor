const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "../..");
if (!process.argv[2] || !process.argv[3])
  throw new Error(
    "Usage: node tools/audits/pill-tooltip-browser.cjs BASELINE_CHECKOUT OUTPUT_DIRECTORY",
  );
const baseline = path.resolve(process.argv[2]);
const webpack = require(root + "/node_modules/webpack");
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
async function compile(label, repo) {
  const compiler = webpack({
    mode: "production",
    entry: repo + "/lib/plugins/pluginbase.js",
    output: {
      path: out,
      filename: label + ".js",
      library: { name: "NightscoutPluginBase", type: "window" },
    },
  });
  await new Promise((resolve, reject) =>
    compiler.run((err, stats) =>
      compiler.close(() =>
        err || stats.hasErrors()
          ? reject(err || new Error(stats.toString()))
          : resolve(),
      ),
    ),
  );
}
(async () => {
  await compile("baseline", baseline);
  await compile("candidate", root);
  const results = [];
  for (let run = 0; run < 7; run++)
    for (const label of ["baseline", "candidate"]) {
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE,
      });
      const context = await browser.newContext({
        hasTouch: true,
        viewport: { width: 800, height: 600 },
      });
      const page = await context.newPage();
      await page.setContent(
        '<div style="width:800px"><div id="pills" style="padding:20px"></div><div><div id="tooltip" style="display:none;position:absolute"></div></div></div>',
      );
      await page.addScriptTag({
        path: root + "/node_modules/jquery/dist/jquery.js",
      });
      await page.addScriptTag({ path: out + "/" + label + ".js" });
      await page.evaluate(() => {
        const node = document.querySelector("#tooltip");
        window.renders = 0;
        const tooltip = {
          node: () => node,
          style: (name, value) => {
            if (name === "display" && value === "block") window.renders++;
            node.style[name] = value;
            return tooltip;
          },
        };
        window.base = window.NightscoutPluginBase(
          $("#pills"),
          $("#pills"),
          $("#pills"),
          $("#pills"),
          tooltip,
        );
        window.plugin = { name: "memory", pluginType: "pill-major" };
        window.references = [];
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send("HeapProfiler.collectGarbage");
      const before = await cdp.send("Runtime.getHeapUsage");
      await page.evaluate(() => {
        for (let update = 0; update < 100; update++) {
          const info = Array.from({ length: 100 }, (_, index) => ({
            label: "Reading " + index,
            value:
              Array.from({ length: 64 }, (_, i) =>
                String.fromCharCode(65 + ((i + update + index) % 26)),
              ).join("") +
              " " +
              update,
          }));
          window.references.push(new WeakRef(info));
          window.base.updatePillText(window.plugin, {
            label: "Glucose",
            value: "126 mg/dL",
            info,
          });
        }
      });
      await cdp.send("HeapProfiler.collectGarbage");
      const after = await cdp.send("Runtime.getHeapUsage");
      const retention = await page.evaluate(() => ({
        retainedOptions: references.filter((ref) => ref.deref()).length,
        handlers: Object.fromEntries(
          Object.entries(
            $._data(document.querySelector(".pill"), "events"),
          ).map(([event, handlers]) => [event, handlers.length]),
        ),
      }));
      await page.locator(".pill").hover();
      const hovered = await page.evaluate(() => ({
        renders,
        display: document.querySelector("#tooltip").style.display,
        text: document.querySelector("#tooltip").textContent.slice(-3),
      }));
      await page.mouse.move(790, 590);
      const hidden = await page
        .locator("#tooltip")
        .evaluate((n) => n.style.display);
      if (hovered.display !== "block" || hidden !== "none")
        throw new Error("Hover behavior failed");
      if (
        label === "candidate" &&
        (retention.retainedOptions !== 1 ||
          retention.handlers.mouseover !== 1 ||
          hovered.renders !== 1)
      )
        throw new Error(JSON.stringify({ retention, hovered }));
      await page.locator(".pill").tap();
      const touched = await page
        .locator("#tooltip")
        .evaluate((n) => n.style.display);
      await page.keyboard.press("Tab");
      const keyboard = await page.evaluate(() => ({
        tag: document.activeElement.tagName,
        display: document.querySelector("#tooltip").style.display,
      }));
      await page.evaluate(() =>
        window.base.updatePillText(window.plugin, {
          label: "Glucose",
          value: "7 mmol/L",
          info: [],
        }),
      );
      const removed = await page.evaluate(() => ({
        display: document.querySelector("#tooltip").style.display,
        handlers: Object.keys(
          $._data(document.querySelector(".pill"), "events") || {},
        ),
      }));
      if (
        label === "candidate" &&
        (removed.display !== "none" || removed.handlers.length)
      )
        throw new Error("Cleanup failed");
      results.push({
        run,
        label,
        chromium: browser.version(),
        before: before.usedSize,
        after: after.usedSize,
        delta: after.usedSize - before.usedSize,
        ...retention,
        hovered,
        touched,
        keyboard,
        removed,
      });
      await browser.close();
    }
  for (let run = 0; run < 7; run++) {
    const pair = results.filter((r) => r.run === run);
    if (
      pair[0].touched !== pair[1].touched ||
      JSON.stringify(pair[0].keyboard) !== JSON.stringify(pair[1].keyboard)
    )
      throw new Error("Touch/keyboard parity failed");
  }
  fs.writeFileSync(
    out + "/browser-results.json",
    JSON.stringify(results, null, 2),
  );
  for (const label of ["baseline", "candidate"]) {
    const values = results
      .filter((r) => r.label === label)
      .map((r) => r.delta)
      .sort((a, b) => a - b);
    console.log(label, { median: values[3], min: values[0], max: values[6] });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
