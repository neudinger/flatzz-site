const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function checkExamples(installed, flatzz) {
  const catalog = JSON.parse(fs.readFileSync(path.join(installed, "examples/catalog.json"), "utf8"));
  for (const entry of ["flatbuf/reading.fbs", "readme/rocket.fbs", "flatbuf/mission/mission.fbs", "flatbuf/monster.fbs"])
    assert.ok(catalog.schemas.some(example => example.entry === entry), entry);
  assert.equal(new Set(catalog.schemas.map(example => example.key)).size, catalog.schemas.length);
  for (const key of ["builder", "generated", "mission", "monster", "readme", "reflection", "schema_json"])
    assert.ok(catalog.programs.some(program => program.key === key), key);
  const official = path.join(flatzz, "example");
  function schemas(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const filename = path.join(directory, entry.name);
      if (entry.name.startsWith(".") || ["zig-out", "node_modules"].includes(entry.name)) return [];
      return entry.isDirectory() ? schemas(filename) : entry.isFile() && entry.name.endsWith(".fbs") ? [filename] : [];
    });
  }
  const officialSources = schemas(official).map(filename => path.relative(official, filename).split(path.sep).join("/")).sort();
  assert.deepEqual(catalog.sources, officialSources, "Every official FBS is imported");
  for (const filename of catalog.sources) assert.deepEqual(
    fs.readFileSync(path.join(installed, "examples/sources", filename)),
    fs.readFileSync(path.join(official, filename)), filename);
  for (const example of catalog.schemas) {
    assert.equal(example.files[0], example.entry);
    for (const filename of example.files) assert.ok(catalog.sources.includes(filename));
  }
  function programs(directory, prefix = "") {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (entry.name.startsWith(".") || ["zig-out", "node_modules"].includes(entry.name)) return [];
      const relative = path.posix.join(prefix, entry.name);
      return entry.isDirectory() ? programs(path.join(directory, entry.name), relative)
        : entry.isFile() && entry.name === "main.zig" ? [path.posix.dirname(relative)] : [];
    });
  }
  assert.deepEqual(catalog.programs.map(program => program.key).sort(), programs(official).sort(),
    "Every official example project is visible");
  for (const program of catalog.programs) {
    assert.ok(program.files.includes("main.zig"));
    for (const key of program.schemas) assert.ok(catalog.schemas.some(example => example.key === key));
    for (const filename of program.files) assert.deepEqual(
      fs.readFileSync(path.join(installed, "examples/programs", program.key, filename)),
      fs.readFileSync(path.join(official, program.key, filename)), `${program.key}/${filename}`);
  }
  assert.deepEqual(fs.readFileSync(path.join(installed, "examples/README.md")),
    fs.readFileSync(path.join(official, "README.md")));
  assert.ok(!fs.existsSync(path.join(__dirname, "../examples")), "Site owns no copied schema directory");

  const { loadExamples, isOriginalProject } = await import(pathToFileURL(
    path.join(installed, "assets/examples.js")));
  const savedFetch = global.fetch;
  try {
    global.fetch = async url => new Response(fs.readFileSync(url));
    const loaded = await loadExamples(pathToFileURL(`${path.join(installed, "examples")}/`));
    const mission = loaded.schemas.find(example => example.entry === "flatbuf/mission/mission.fbs");
    assert.deepEqual(Object.keys(mission.project.files), ["flatbuf/mission/mission.fbs", "flatbuf/mission/common.fbs"]);
    assert.ok(isOriginalProject(mission.project, mission.original));
    mission.project.files["flatbuf/mission/common.fbs"] += "\n// edit\n";
    assert.ok(!isOriginalProject(mission.project, mission.original), "Includes invalidate runtime offsets");
    assert.notEqual(mission.project.files["flatbuf/mission/common.fbs"], mission.original.files["flatbuf/mission/common.fbs"]);
    mission.project = structuredClone(mission.original);
    mission.project.entry = "flatbuf/mission/common.fbs";
    assert.ok(!isOriginalProject(mission.project, mission.original));
    mission.project = structuredClone(mission.original);
    mission.project.files["extra.fbs"] = "";
    assert.ok(!isOriginalProject(mission.project, mission.original));
    mission.project = structuredClone(mission.original);
    assert.ok(isOriginalProject(mission.project, mission.original), "Reset restores verified offsets");
    global.fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(loadExamples(), /Cannot load example catalog/);
  } finally { global.fetch = savedFetch; }
  console.log(`Official catalogue passed: ${catalog.sources.length} FBS files and ${catalog.programs.length} programs match Flatzz; linked drafts/reset verified.`);
  return catalog;
};
