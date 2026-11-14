// Discover's logos stay readable in the recommendation, ranking and cards.
// An edge-to-edge third-party image stays inside the rounded tile; a line
// logo and a missing image still render. No network or live config.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(process.env.MAGPIE_ASSETS || path.join(__dirname, "../assets"));
const listings = [
  { package: "example/square", name: "Square", community: true, icon: "file:square.svg", providers: ["square"], npm: { version: "1.0.0", weekly: 300 } },
  { package: "example/line", name: "Line", icon: "cursor", providers: ["line"], npm: { version: "1.0.0", weekly: 200 } },
  { package: "example/missing", name: "Missing", icon: "file:missing.svg", providers: ["missing"], npm: { version: "1.0.0", weekly: 100 } },
  { package: "example/wide", name: "Wide", icon: "file:wide.svg", providers: ["wide"], npm: { version: "1.0.0", weekly: 50 } },
];
const npm = Object.fromEntries(listings.map((l) => [l.package, l.npm]));
const state = { bun: true, plugins: [] };
const square = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path fill="#ff0000" d="M0 0h20v40H0z"/><path fill="#0000ff" d="M20 0h20v40H20z"/></svg>';
const wide = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><path fill="#ff0000" d="M0 0h20v20H0z"/><path fill="#0000ff" d="M20 0h20v20H20z"/></svg>';

function serve(lang, theme) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.host !== "magpie.test") return route.fulfill({ status: 404, body: "" });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"${theme}",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme } });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true }, plugins: [] });
    if (url.pathname === "/api/groups") return json({ groups: [], pools: [] });
    if (url.pathname === "/api/plugins") return json(state);
    if (url.pathname === "/api/plugins/listings") return json({ listings });
    if (url.pathname === "/api/plugins/market") return json({ listings, state });
    if (url.pathname === "/api/plugins/npm") return json({ npm });
    if (url.pathname === "/api/plugins/github") return json({ listings: [] });
    if (url.pathname === "/api/icons/square.svg") return route.fulfill({ contentType: "image/svg+xml", body: square });
    if (url.pathname === "/api/icons/wide.svg") return route.fulfill({ contentType: "image/svg+xml", body: wide });
    if (url.pathname.startsWith("/api/icons/")) return route.fulfill({ status: 404, body: "" });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

// Read a tile's corner and centre as painted, including rounded clipping.
async function pixels(page, tile) {
  const shot = (await tile.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const pixel = (px, py) => [...x.getImageData(px, py, 1, 1).data];
    const corner = c.width > 40 ? 3 : 2;
    return { corner: pixel(corner, corner), top: pixel(Math.floor(c.width / 2) - 2, 5), centre: pixel(Math.floor(c.width / 2) - 2, Math.floor(c.height / 2)) };
  }, shot);
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(`${engine}: Discover's logos fit their rounded tiles`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    t.after(() => browser.close());
    for (const [lang, theme] of [["en", "light"], ["zh", "dark"], ["zh-TW", "dark"], ["ja", "light"], ["de", "dark"]]) for (const width of [1180, 420]) {
      await t.test(`${lang} ${width}`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 820 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        page.setDefaultNavigationTimeout(60000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, theme));
        await page.goto("http://magpie.test/?view=plugins");
        const view = page.locator("#view-plugins");
        const squareCard = view.locator('.pm-card[data-pkg="example/square"] .pm-logo');
        await squareCard.locator("img").waitFor();
        await page.waitForFunction(() => document.querySelector('.pm-card[data-pkg="example/square"] img')?.naturalWidth > 0);
        await view.locator('.pm-card[data-pkg="example/missing"] .ic.generic').waitFor();
        await view.locator('.pm-card[data-pkg="example/line"] .ic .mask').waitFor();
        for (const selector of ['.pm-hero .pm-logo', '.pm-rrow[data-pkg="example/square"] .pm-logo', '.pm-card[data-pkg="example/square"] .pm-logo']) {
          const tile = view.locator(selector);
          const size = await tile.evaluate((el) => {
            const box = el.getBoundingClientRect(), icon = el.querySelector(".ic").getBoundingClientRect();
            return { box: box.width, icon: icon.width, left: icon.left - box.left, right: box.right - icon.right };
          });
          assert.ok(size.icon / size.box >= 0.8 && size.icon < size.box, `${selector}: logo ${size.icon} in ${size.box}`);
          assert.ok(Math.abs(size.left - size.right) < 1, `${selector}: logo is centred`);
        }
        const { corner, centre } = await pixels(page, view.locator('.pm-hero .pm-logo'));
        assert.ok(!(corner[0] > 200 && corner[1] < 80 && corner[2] < 80), `square picture escapes the rounded corner: ${corner}`);
        assert.ok(centre[0] > 200 && centre[1] < 80 && centre[2] < 80, `square picture is visible: ${centre}`);
        const wideRank = view.locator('.pm-rrow[data-pkg="example/wide"] .pm-logo');
        await wideRank.locator("img").waitFor();
        await page.waitForFunction(() => document.querySelector('.pm-rrow[data-pkg="example/wide"] img')?.naturalWidth > 0);
        const widePixels = await pixels(page, wideRank);
        assert.ok(widePixels.centre[0] > 200 && widePixels.centre[1] < 80 && widePixels.centre[2] < 80, `wide picture is visible: ${widePixels.centre}`);
        assert.ok(!(widePixels.top[0] > 200 && widePixels.top[1] < 80 && widePixels.top[2] < 80), `wide picture is not stretched to the tile: ${widePixels.top}`);
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  });
}
