const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { gunzipSync } = require("node:zlib");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

async function checkDocumentation(site, raw, installed) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  assert.ok(!fs.existsSync(path.join(installed, "_partials")), "Build-only API fragments are not published");
  const catalog = JSON.parse(fs.readFileSync(path.join(installed, "examples/catalog.json"), "utf8"));
  const page = fs.readFileSync(path.join(installed, "examples/index.html"), "utf8");
  assert.match(page, /examples-page.js/);
  assert.match(page, /program-navigation/);
  assert.match(page, /reference.css/);
  const { highlight } = await import(pathToFileURL(path.join(installed, "assets/highlight.js")));
  const text = html => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const program of catalog.programs) for (const name of program.files) {
    const source = fs.readFileSync(path.join(installed, "examples/programs", program.key, name), "utf8");
    assert.equal(text(highlight(source)), source, `Copyable exact source: ${program.key}/${name}`);
  }
  assert.equal(text(highlight('<script>alert("&");</script>')), '<script>alert("&");</script>');
  assert.ok(!highlight('<script>alert("&");</script>').includes("<script>"));

  function localLinks(filename) {
    const html = fs.readFileSync(filename, "utf8");
    const prefix = new URL("https://example.test/flatzz-site/");
    const relative = path.relative(installed, filename).split(path.sep).join("/");
    for (const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
      const url = new URL(match[1].replaceAll("&amp;", "&"), new URL(relative, prefix));
      if (url.origin !== prefix.origin) continue;
      assert.ok(url.pathname.startsWith(prefix.pathname), `Preserve repository prefix: ${url}`);
      let target = path.join(installed, decodeURIComponent(url.pathname.slice(prefix.pathname.length)));
      if (fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
      assert.ok(fs.statSync(target).isFile(), `Local asset: ${target}`);
    }
  }
  localLinks(path.join(installed, "docs/index.html"));
  localLinks(path.join(installed, "examples/index.html"));
  for (const [name, relative, required, textPattern] of [
    ["runtime", "", ["Builder", "Verifier", "Schema", "Serialized", "storage", "MutationError"], /borrow|lifetime/i],
    ["compiler", "compiler", ["parser", "reflection", "bfbs", "json"], /arena|ownership/i],
  ]) {
    const directory = path.join(installed, "docs/api", name);
    const html = fs.readFileSync(path.join(directory, "index.html"), "utf8");
    assert.match(html, /reference.css/);
    assert.match(html, /reference.js/);
    assert.match(html, /sources.tar.gz/);
    assert.ok(!html.includes('id="logo"') && !html.includes('<style type="text/css">'));
    assert.ok(!/{{\w+}}/.test(html));
    localLinks(path.join(directory, "index.html"));
    const script = fs.readFileSync(path.join(directory, "main.js"), "utf8");
    assert.match(script, /DecompressionStream\("gzip"\)/);
    assert.ok(!script.includes('fetch("sources.tar")'));
    const bytes = fs.readFileSync(path.join(directory, "main.wasm"));
    assert.deepEqual(bytes, fs.readFileSync(path.join(raw, relative, "main.wasm")), "Compiler-owned renderer is unchanged");
    const archive = gunzipSync(fs.readFileSync(path.join(directory, "sources.tar.gz")));
    assert.deepEqual(archive, fs.readFileSync(path.join(raw, relative, "sources.tar")), "Source archive is lossless");
    const { instance } = await WebAssembly.instantiate(bytes, { js: { log() {} } });
    const api = instance.exports;
    const pointer = api.alloc(archive.length);
    new Uint8Array(api.memory.buffer, pointer, archive.length).set(archive);
    api.unpack(pointer, archive.length);
    const string = value => decoder.decode(new Uint8Array(api.memory.buffer,
      Number(value & 0xffffffffn), Number(value >> 32n)));
    assert.equal(string(api.module_name(0)), name);
    const root = api.find_module_root(0);
    assert.match(string(api.decl_docs_html(root, false)), textPattern);
    const slice = api.namespace_members(root, false);
    const members = Array.from(new Uint32Array(api.memory.buffer, Number(slice & 0xffffffffn), Number(slice >> 32n)));
    const names = members.map(index => string(api.decl_name(index)));
    for (const symbol of required) assert.ok(names.includes(symbol), `Public API: ${name}.${symbol}`);
    for (const index of members) {
      const qualified = encoder.encode(string(api.decl_fqn(index)));
      const input = api.set_input_string(qualified.length);
      new Uint8Array(api.memory.buffer, input, qualified.length).set(qualified);
      assert.notEqual(api.find_decl(), -1, "Public declaration links resolve");
    }
    const query = encoder.encode(name === "runtime" ? "capacityFor" : "parseWithOptions");
    const queryPointer = api.query_begin(query.length);
    new Uint8Array(api.memory.buffer, queryPointer, query.length).set(query);
    const results = api.query_exec(true);
    assert.ok(new Uint32Array(api.memory.buffer, results, 1)[0] > 0, "Compiler search returns API results");
    const source = string(api.decl_source_html(root));
    assert.match(source, /tok-/);
    assert.match(string(api.decl_line_numbers_html(root)), /<span>1<\/span>/);
  }
  for (const name of ["README.md", "examples.md", "wasm.md"]) assert.deepEqual(
    fs.readFileSync(path.join(installed, "docs/downloads", name)),
    fs.readFileSync(path.join(raw, "guides", name)), "Guides come from the library");

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flatzz-reference-"));
  try {
    const output = path.join(temporary, "prepared");
    function prepareDocumentation(input, destination) {
      const result = spawnSync(site, ["prepare-api", input, destination], {
        encoding: "utf8", timeout: 60000,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr);
    }
    const snapshot = () => Object.fromEntries(["runtime", "compiler"].flatMap(name =>
      fs.readdirSync(path.join(output, name)).sort().map(filename =>
        [`${name}/${filename}`, fs.readFileSync(path.join(output, name, filename)).toString("base64")])));
    prepareDocumentation(raw, output);
    const original = snapshot();
    for (const name of ["runtime", "compiler"]) {
      assert.deepEqual(fs.readdirSync(path.join(output, name)).sort(),
        ["body.html", "head.html", "main.js", "main.wasm", "sources.tar.gz"]);
      const body = fs.readFileSync(path.join(output, name, "body.html"), "utf8");
      assert.ok(!/<(?:html|head|body|nav)(?:\s|>)/.test(body), "Zine owns the page shell");
      assert.match(body, /id="search"/);
      const head = fs.readFileSync(path.join(output, name, "head.html"), "utf8");
      assert.match(head, /href="main.wasm"/);
      assert.match(head, /href="sources.tar.gz"/);
      assert.ok(!head.includes("sources.tar\""));
      assert.ok(!fs.existsSync(path.join(installed, "docs/api", name, "body.html")),
        "Viewer fragments are Zine build inputs, not public routes");
    }
    fs.writeFileSync(path.join(output, "obsolete.txt"), "stale");
    prepareDocumentation(raw, output);
    assert.ok(!fs.existsSync(path.join(output, "obsolete.txt")), "Preparation prunes stale output");
    assert.deepEqual(snapshot(), original, "Repeated preparation is deterministic");
    const unsupported = path.join(temporary, "unsupported");
    fs.mkdirSync(unsupported);
    fs.writeFileSync(path.join(unsupported, "index.html"), "<body>Changed viewer</body>");
    assert.throws(() => prepareDocumentation(unsupported, output));
    assert.deepEqual(snapshot(), original,
      "Unknown viewer layouts preserve the last prepared output");

    const damaged = path.join(temporary, "damaged");
    fs.cpSync(raw, damaged, { recursive: true });
    for (const invalid of [
      Buffer.from("invalid Wasm"),
      Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 0]),
    ]) {
      fs.writeFileSync(path.join(damaged, "compiler/main.wasm"), invalid);
      assert.throws(() => prepareDocumentation(damaged, output), /InvalidViewerWasm/);
      assert.deepEqual(snapshot(), original, "Both viewers validate before any output is replaced");
    }
    fs.copyFileSync(path.join(raw, "compiler/main.wasm"), path.join(damaged, "compiler/main.wasm"));
    fs.writeFileSync(path.join(damaged, "sources.tar"), "");
    assert.throws(() => prepareDocumentation(damaged, output), /MissingSourceArchive/);
    assert.deepEqual(snapshot(), original);
    prepareDocumentation(raw, output);
    assert.deepEqual(snapshot(), original, "Recovery reproduces the previous complete output");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  console.log("Documentation passed: both public APIs, source and search, exact archives/guides/example source, prefixed links, Zine fragments, deterministic preparation and failure preservation.");
}
module.exports = checkDocumentation;
if (require.main === module) checkDocumentation(...process.argv.slice(2)).catch(error => {
  console.error(error); process.exitCode = 1;
});
