const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("the release publishes the homepage, documentation, and theme", () => {
  const home = fs.readFileSync("dist/index.html", "utf8");
  const docs = fs.readFileSync("dist/docs/index.html", "utf8");
  assert.match(home, /Define in FBS/);
  assert.match(home, /href="\/flatzz-site\/assets\/site.css"/);
  assert.match(home, /href="\/flatzz-site\/docs\/"/);
  assert.doesNotMatch(home + docs, /<extend|[$]page\./);
  assert(fs.statSync("dist/assets/rocket-ziguana.png").size > 0);
  assert(fs.statSync("dist/assets/fonts/InterVariable.woff2").size > 0);
});
