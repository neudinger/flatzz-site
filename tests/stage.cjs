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

test("the release publishes the official catalogue and source browser", () => {
  const page = fs.readFileSync("dist/examples/index.html", "utf8");
  assert.match(page, /program-navigation/);
  const catalogue = JSON.parse(fs.readFileSync("dist/examples/catalog.json", "utf8"));
  assert(catalogue.schemas.some(schema => schema.entry === "flatbuf/monster.fbs"));
  assert(catalogue.programs.some(program => program.key === "readme"));
});

test("the release includes the compiler, adapter, and browser worker", () => {
  const compiler = fs.readFileSync("dist/assets/flatzz-compiler.wasm");
  assert(WebAssembly.validate(compiler));
  assert(fs.statSync("dist/assets/compiler.mjs").size > 0);
  assert(fs.statSync("dist/assets/compiler-worker.js").size > 0);
});

test("the playground exposes all three conversions and fixed-buffer runtime", () => {
  const home = fs.readFileSync("dist/index.html", "utf8");
  for (const mode of ["fbs-zig", "fbs-json", "bfbs-zig"]) {
    assert.match(home, new RegExp(`data-mode="${mode}"`));
  }
  assert.match(home, /data-runtime="\/flatzz-site\/assets\/runtime\.wasm"/);
  assert(WebAssembly.validate(fs.readFileSync("dist/assets/runtime.wasm")));
});
