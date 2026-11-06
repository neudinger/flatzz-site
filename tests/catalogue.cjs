const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

module.exports = function checkCatalogue(site, compiler) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "flatzz-auto-catalogue-"));
  const official = path.join(temporary, "official examples");
  const output = path.join(temporary, "generated examples");
  function write(relative, contents) {
    const filename = path.join(official, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  function files(directory, prefix = "") {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const relative = prefix + entry.name;
      return entry.isDirectory() ? files(path.join(directory, entry.name), relative + "/") : [relative];
    }).sort();
  }
  function snapshot() {
    return Object.fromEntries(files(output).map(filename =>
      [filename, fs.readFileSync(path.join(output, filename)).toString("base64")]));
  }
  function generate(...arguments_) {
    const result = spawnSync(site, ["catalog", compiler, official, output, ...arguments_], {
      encoding: "utf8", timeout: 60000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
  }
  const catalog = () => JSON.parse(fs.readFileSync(path.join(output, "catalog.json"), "utf8"));
  function convert(format, entry) {
    const result = spawnSync(compiler, [format, fs.realpathSync(path.join(official, entry))], { maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, String(result.stderr));
    return result.stdout;
  }
  try {
    write("README.md", "# Fixture examples\n");
    write("schemas/shared/coordinates.fbs", "struct Coordinates { north:double; }\n");
    write("schemas/flight/common.fbs", 'include "../shared/coordinates.fbs"; struct Position { point:Coordinates; }\n');
    write("schemas/flight/flight.fbs", 'include "common.fbs"; table Flight { name:string; position:Position; } root_type Flight;\n');
    write("first/packet.fbs", "table Alpha { precise:long = 9007199254740993; } root_type Alpha;\n");
    write("second/packet.fbs", "table Beta { ready:bool; } root_type Beta;\n");
    write("space schemas/with spaces.fbs", "table Space { count:uint; } root_type Space;\n");
    write("extras/types.fbs", '// root_type Missing; include "absent.fbs";\nstruct Extra { rank:uint; }\n');
    write("nested/new demo/main.zig", '//! New example.\nconst helper = @import("support/helper.zig");\npub fn main() void { _ = helper.answer; }\n');
    write("nested/new demo/support/helper.zig", "pub const answer = 42;\n");
    write("nested/new demo/build.zig", 'const std = @import("std");\npub fn build(_: *std.Build) void {}\n');
    write("nested/new demo/build.zig.zon", '.{ .name = .fixture }\n');
    write("nested/new demo/README.md", "# New program\n");
    for (const excluded of [".git", ".hidden", ".zig-cache", "zig-out"]) {
      write(`${excluded}/bad.fbs`, "not a schema");
      write(`${excluded}/main.zig`, "not a program");
    }
    const outside = path.join(temporary, "outside.fbs");
    fs.writeFileSync(outside, "struct Outside { value:uint; }\n");
    fs.symlinkSync(outside, path.join(official, "linked.fbs"));
    fs.symlinkSync(official, path.join(official, "cycle"), "dir");

    generate();
    const initial = catalog();
    const expectedSources = ["extras/types.fbs", "first/packet.fbs", "schemas/flight/common.fbs",
      "schemas/flight/flight.fbs", "schemas/shared/coordinates.fbs",
      "second/packet.fbs", "space schemas/with spaces.fbs"];
    assert.deepEqual(initial.sources, expectedSources);
    assert.deepEqual(initial.schemas.map(schema => schema.entry),
      ["first/packet.fbs", "schemas/flight/flight.fbs", "second/packet.fbs", "space schemas/with spaces.fbs"]);
    assert.deepEqual(initial.schemas.map(schema => schema.key),
      ["first/packet", "schemas/flight/flight", "second/packet", "space schemas/with spaces"]);
    const flight = initial.schemas.find(schema => schema.entry === "schemas/flight/flight.fbs");
    assert.deepEqual(flight.files, ["schemas/flight/flight.fbs", "schemas/flight/common.fbs",
      "schemas/shared/coordinates.fbs"], "Entry precedes sorted transitive dependencies");
    for (const schema of initial.schemas) {
      assert.equal(schema.runtime, undefined, "New schemas have no invented runtime frame");
      assert.ok(schema.title.length && schema.description.length);
      for (const [extension, flag] of [["zig", "--zig"], ["bfbs", "--bfbs"], ["json", "--json"]]) {
        assert.deepEqual(fs.readFileSync(path.join(output, "generated", `${schema.key}.${extension}`)),
          convert(flag, schema.entry), `${schema.entry}: exact native ${extension}`);
      }
    }
    assert.match(fs.readFileSync(path.join(output, "generated/first/packet.json"), "utf8"), /9007199254740993/);
    for (const filename of expectedSources) assert.deepEqual(
      fs.readFileSync(path.join(output, "sources", filename)), fs.readFileSync(path.join(official, filename)));
    assert.deepEqual(fs.readFileSync(path.join(output, "README.md")),
      fs.readFileSync(path.join(official, "README.md")));
    assert.deepEqual(initial.programs.map(program => program.key), ["nested/new demo"]);
    const program = initial.programs[0];
    assert.deepEqual(program.schemas, [], "A new unrelated program needs no guessed schema association");
    assert.deepEqual(program.files, ["README.md", "build.zig", "build.zig.zon", "main.zig", "support/helper.zig"]);
    for (const filename of program.files) assert.deepEqual(
      fs.readFileSync(path.join(output, "programs", program.key, filename)),
      fs.readFileSync(path.join(official, program.key, filename)));

    const firstOutput = snapshot();
    fs.writeFileSync(path.join(output, "obsolete.txt"), "stale generated output");
    generate();
    assert.deepEqual(snapshot(), firstOutput, "Repeated generation is deterministic and prunes stale output");

    write("new official/new.fbs", "table New { value:uint; } root_type New;\n");
    write("new official/main.zig", "pub fn main() void {}\n");
    generate();
    assert.ok(catalog().schemas.some(schema => schema.key === "new official/new"));
    assert.ok(catalog().programs.some(program => program.key === "new official"));
    assert.ok(fs.existsSync(path.join(output, "generated/new official/new.bfbs")));
    fs.rmSync(path.join(official, "new official"), { recursive: true });
    fs.rmSync(path.join(official, "second/packet.fbs"));
    fs.rmSync(path.join(official, "nested/new demo"), { recursive: true });
    generate();
    assert.ok(!catalog().schemas.some(schema => schema.key === "new official/new"));
    assert.ok(!catalog().schemas.some(schema => schema.key === "second/packet"));
    assert.deepEqual(catalog().programs, []);
    for (const obsolete of ["generated/new official/new.bfbs", "generated/second/packet.zig", "sources/second/packet.fbs",
      "programs/nested/new demo/main.zig"]) assert.ok(!fs.existsSync(path.join(output, obsolete)), obsolete);
    const successful = snapshot();
    for (const source of [
      "table Invalid { value:Missing; } root_type Invalid;",
      'include "absent.fbs"; table Invalid {} root_type Invalid;',
      'include "../outside.fbs"; table Invalid { value:Outside; } root_type Invalid;',
    ]) {
      write("invalid.fbs", source);
      assert.throws(() => generate());
      assert.deepEqual(snapshot(), successful, "Failed generation preserves the last successful output");
      fs.rmSync(path.join(official, "invalid.fbs"));
    }
    generate();
    assert.deepEqual(snapshot(), successful, "Recovery reproduces the successful catalogue");
    const alias = path.join(temporary, "source alias");
    fs.symlinkSync(official, alias, "dir");
    for (const destination of [path.join(alias, "catalog"), path.join(alias, "missing", "catalog")]) {
      const result = spawnSync(site, ["catalog", compiler, official, destination], {
        encoding: "utf8", timeout: 60000,
      });
      if (result.error) throw result.error;
      assert.notEqual(result.status, 0, "The catalogue cannot replace its own inputs");
      assert.ok(fs.lstatSync(alias).isSymbolicLink(), "A source alias must remain intact");
    }
    assert.ok(!fs.existsSync(path.join(official, "missing")), "No output directories in the source tree");
    const cwd = path.join(temporary, "coordinator cwd");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "keep"), "source");
    const overlap = spawnSync(site, ["catalog", compiler, official, "."], { cwd, encoding: "utf8", timeout: 60000 });
    if (overlap.error) throw overlap.error;
    assert.notEqual(overlap.status, 0, "The catalogue cannot replace the working directory");
    assert.equal(fs.readFileSync(path.join(cwd, "keep"), "utf8"), "source");
    const presets = path.join(temporary, "presets.json");
    fs.writeFileSync(presets, JSON.stringify({ "first/packet.fbs": { kind: 7 } }));
    generate(presets);
    assert.deepEqual(catalog().schemas.find(schema => schema.entry === "first/packet.fbs").runtime,
      { kind: 7 }, "Runtime IDs come only from explicit site-owned presets");
    assert.ok(catalog().schemas.filter(schema => schema.entry !== "first/packet.fbs")
      .every(schema => schema.runtime === null), "Unconfigured schemas remain compiler-only");
    console.log("Automatic catalogue passed: roots/includes, nested sources, duplicate names, additions/removals, deterministic output, stale file pruning, and failure preservation.");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
};

if (require.main === module) {
  try { module.exports(...process.argv.slice(2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
