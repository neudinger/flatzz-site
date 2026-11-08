const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

(async () => {
  const [wasmPath, zig, flatzz, installed] = process.argv.slice(2);
  const { pathToFileURL } = require("node:url");
  const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
  assert.deepEqual(WebAssembly.Module.imports(module), [], "Compiler has no host/WASI imports");
  const instance = await WebAssembly.instantiate(module, {});
  const engine = instance.exports;
  assert.equal(engine.abiVersion(), 1);
  const { Compiler } = await import(pathToFileURL(path.join(installed, "assets/compiler.mjs")));
  const compiler = new Compiler(instance);
  const { convertRequest, diagnosticMessage } = await import(
    pathToFileURL(path.join(installed, "assets/compiler-service.js")));
  const { schemaReport, rootObject, usageExample, parseSchemaJson } = await import(
    pathToFileURL(path.join(installed, "assets/schema-model.js")));
  const { projectRequest, readFbsProject, readBfbsFile } = await import(
    pathToFileURL(path.join(installed, "assets/source-project.js")));
  function compile(source, expectError) {
    const request = typeof source === "string" ? { source, output: "zig" } : source;
    if (expectError) {
      assert.throws(() => convertRequest(compiler, request), error => {
        assert.match(diagnosticMessage(error), expectError);
        return true;
      });
      return;
    }
    const result = convertRequest(compiler, request);
    assert.ok(result.schema, result.note);
    return result.schema;
  }
  const cases = [];
  const catalog = await require("./examples.cjs")(installed, flatzz);
  const fieldNames = {
    "flatbuf/reading.fbs": ["sequence", "value", "label", "active", "status", "samples", "temperature", "tags", "location", "history", "calibration"],
    "readme/rocket.fbs": ["id", "fuel", "pilot", "payload"],
    "flatbuf/mission/mission.fbs": ["name", "position"],
    "flatbuf/monster.fbs": ["pos", "mana", "hp", "name", "inventory", "color", "test"],
  };
  for (const example of catalog.schemas) {
    const key = example.key;
    const project = { entry: example.entry, files: Object.fromEntries(example.files.map(filename =>
      [filename, fs.readFileSync(path.join(installed, "examples/sources", filename), "utf8")])) };
    const request = projectRequest(project);
    const schema = compile(request);
    assert.equal(schema.generated, fs.readFileSync(path.join(installed, `examples/generated/${key}.zig`), "utf8"), "Browser and CLI output must match exactly");
    if (fieldNames[example.entry]) assert.deepEqual(schemaReport(schema).fields.map(field => field.name), fieldNames[example.entry]);
    const testName = `official_${cases.length}`;
    cases.push([testName, schema]);
    const binary = fs.readFileSync(path.join(installed, `examples/generated/${key}.bfbs`));
    const imported = await readBfbsFile(new File([binary], `${key}.bfbs`), compiler.limits);
    const result = convertRequest(compiler, { input: "bfbs", output: "zig", source: imported.bytes });
    assert.equal(result.output, schema.generated, "BFBS and FBS generate the same Zig");
    cases.push([`bfbs_${testName}`, result.schema]);
    const json = convertRequest(compiler, { ...request, output: "json" });
    assert.equal(json.output, compiler.convert({ ...request, output: "json" }), "JSON stays exact text");
    assert.equal(parseSchemaJson(json.output).root_table.name, rootObject(schema).name);
    if (example.entry === "flatbuf/mission/mission.fbs") {
      project.files["flatbuf/mission/common.fbs"] = project.files["flatbuf/mission/common.fbs"].replace("north:float", "north:double");
      assert.match(compile(projectRequest(project)).generated, /north: f64/,
        "The official include participates in live generation");
    }
  }
  const additions = [
    ["flight", "table Flight { mass:double; callsign:string; online:bool = true; samples:[short]; } root_type Flight;"],
    ["nested", "namespace Flight; enum Mode:ubyte { Idle, Launch } struct Vec3 { x:float; y:float; z:float; } table Engine { thrust:uint; } table Ship { mode:Mode = Launch; pos:Vec3; engine:Engine (required); pilot:string (required); count:ulong; } root_type Ship;"],
    ["names", "namespace Alpha; table Part { level:int; } namespace Beta; table Envelope { type:int; child:Alpha.Part; } root_type Envelope;"],
    ["unions", "table Fuel { amount:float; } union Payload { Fuel } table Packet { current:Payload; sequence:uint; } root_type Packet;"],
    ["arrays", "struct Point { coordinates:[float:3]; } table Packet { pos:Point; active:bool; } root_type Packet;"],
    ["empty", "table Empty {} root_type Empty;"],
    ["enum_only", "enum Mode:ubyte { Idle, Launch } table Packet { mode:Mode; } root_type Packet;"],
    ["strings", "table Packet { label:string (required); } root_type Packet;"],
    ["optional", "table Packet { count:int = null; active:bool = null; } root_type Packet;"],
    ["vector_only", "table Packet { samples:[int]; } root_type Packet;"],
    ["bool_vector", "table Packet { flags:[bool]; } root_type Packet;"],
    ["struct_only", "struct Position { value:float; } table Packet { pos:Position; } root_type Packet;"],
    ["wide_enum", "enum Mode:ulong { Idle = 18446744073709551614, Active = 18446744073709551615 } table Packet { mode:Mode = Idle; } root_type Packet;"],
    ["union_vectors", "table Node { value:uint; } union Payload { Node } table Packet { payloads:[Payload]; old:int (deprecated); serial:uint; } root_type Packet;"],
    ["large_payload", `struct Payload {
      first:[double:64]; second:[double:64]; third:[double:64];
      fourth:[double:64]; fifth:[double:64]; sixth:[double:64];
      seventh:[double:64]; eighth:[double:64]; ninth:[double:64];
    } table Packet { payload:Payload; sequence:uint; } root_type Packet;`],
  ];
  for (const [key, source] of additions) cases.push([key, compile(source)]);
  assert.equal(rootObject(cases.find(([name]) => name === "names")[1]).zig_name, '@"Beta.Envelope"');
  const unionReport = schemaReport(cases.find(([name]) => name === "unions")[1]);
  assert.deepEqual(unionReport.fields.map(field => field.name), ["current", "sequence"]);
  const unionVectorReport = schemaReport(cases.find(([name]) => name === "union_vectors")[1]);
  assert.deepEqual(unionVectorReport.fields.map(field => field.name), ["payloads", "serial"]);
  const flight = schemaReport(cases.find(([name]) => name === "flight")[1]);
  assert.deepEqual(flight.fields.map(field => field.name), ["mass", "callsign", "online", "samples"]);
  assert.ok(flight.schema_only);
  assert.ok(flight.fields.every(field => field.slot === null && field.payload === null));
  const noTable = compile("struct Position { value:float; }");
  assert.equal(rootObject(noTable), null);
  assert.match(usageExample(noTable, "position").source, /Add a table/);
  const cycle = compile("table Recursive { child:Recursive (required); } root_type Recursive;");
  assert.match(usageExample(cycle, "recursive").note, /required table cycle/i);
  const largeArray = compile("struct Samples { values:[int:1024]; } table Packet { sample:Samples; } root_type Packet;");
  assert.match(usageExample(largeArray, "large").note, /application-specific/);
  compile("table Broken { fuel:Missing; }", /schema\.fbs:\d+:\d+:/);
  compile("table Broken { fuel:float }", /schema\.fbs:\d+:\d+:/);
  compile('include "other.fbs"; table Root {}', /include|Include/i);
  compile("table Broken { value:uint; value:uint; }", /duplicate|Duplicate|already/i);
  compile(" ".repeat(engine.inputCapacity() + 1), /input exceeds/);
  new Uint8Array(engine.memory.buffer, engine.inputPointer(), 2).set([97, 255]);
  assert.equal(engine.addFile(1, 1), 1);
  const diagnostic = new TextDecoder().decode(new Uint8Array(engine.memory.buffer,
    engine.diagnosticPointer(), engine.diagnosticLength()));
  assert.match(diagnostic, /InvalidUtf8/);
  compile({ input: "bfbs", output: "zig", source: new Uint8Array([1, 2, 3]) }, /InvalidBfbs/);
  const project = await readFbsProject([
    new File(["struct Position { east:float; }"], "common.fbs"),
    new File(['include "common.fbs"; table Mission { name:string; position:Position; } root_type Mission;'], "mission.fbs"),
  ], compiler.limits);
  project.entry = "mission.fbs";
  const linked = compile(projectRequest(project));
  assert.equal(rootObject(linked).name, "Mission");
  cases.push(["linked", linked]);
  project.files["common.fbs"] = "struct Position { north:double; }";
  assert.match(compile(projectRequest(project)).generated, /north: f64/);
  await assert.rejects(readFbsProject([new File([new Uint8Array([255])], "bad.fbs")],
    compiler.limits), /UTF-8/);
  await assert.rejects(readFbsProject([new File([""], "same.fbs"), new File([""], "same.fbs")],
    compiler.limits), /unique filenames/);
  await assert.rejects(readBfbsFile(new File([new Uint8Array(compiler.limits.input_bytes + 1)],
    "large.bfbs"), compiler.limits), /exceeds/);
  const numericJson = convertRequest(compiler, { output: "json", source:
    'table Numeric { precise:long = 9007199254740993; text:string; } root_type Numeric;' });
  assert.match(numericJson.output, /9007199254740993/);
  assert.equal(numericJson.schema.objects[0].fields.find(field => field.name === "precise")
    .default_integer, "9007199254740993");
  assert.equal(parseSchemaJson('{"label":"12345678901234567890","escaped":"\\\"12345678901234567890"}').label,
    "12345678901234567890");
  const namesJson = convertRequest(compiler, { source: "table Root { Schema:uint; } root_type Root;", output: "json" });
  assert.match(namesJson.output, /Schema/);
  const size = engine.memory.buffer.byteLength;
  for (let iteration = 0; iteration < 100; iteration++) {
    const result = compile(`table Recovery { field_${iteration}:uint; } root_type Recovery;`);
    assert.ok(result.generated.includes(`field_${iteration}: u32`));
  }
  assert.equal(engine.memory.buffer.byteLength, size, "Repeated compilation must not grow bounded scratch memory");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flatzz-live-usage-"));
  try {
    // Exercise request ordering and recovery without waiting six seconds per timeout.
    const timers = new Map();
    const workers = [];
    const saved = { Worker: global.Worker, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
    const clientFile = path.join(directory, "compiler-client.mjs");
    fs.copyFileSync(path.join(__dirname, "../assets/compiler-client.js"), clientFile);
    const { SchemaCompiler } = await import(require("node:url").pathToFileURL(clientFile));
    try {
      global.Worker = class {
        constructor() { this.requests = []; workers.push(this); }
        postMessage(request) { this.requests.push(request); }
        terminate() { this.terminated = true; }
      };
      let timerId = 0;
      global.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
      global.clearTimeout = identifier => timers.delete(identifier);
      const received = [];
      const client = new SchemaCompiler(result => received.push(result));
      client.compile({ source: "old edit" });
      const oldRequest = workers[0].requests.at(-1);
      client.compile({ source: "latest edit" });
      workers[0].onmessage({ data: { id: oldRequest.id, result: "stale" } });
      assert.equal(received.length, 0);
      workers[0].onmessage({ data: { id: workers[0].requests.at(-1).id, result: "latest" } });
      assert.equal(received[0].request.source, "latest edit");
      client.compile({ source: "pending edit" });
      const pending = workers[0].requests.at(-1);
      client.invalidate();
      workers[0].onmessage({ data: { id: pending.id, result: "superseded" } });
      assert.equal(received.length, 1);
      client.compile({ source: "slow edit" });
      [...timers.values()][0]();
      assert.ok(workers[0].terminated);
      assert.match(received.at(-1).error, /time limit/);
      client.compile({ source: "recovered edit" });
      workers[0].onerror({ preventDefault() {} });
      assert.ok(!workers[1].terminated, "An obsolete worker must not terminate its replacement");
      workers[1].onmessage({ data: { id: workers[1].requests.at(-1).id, result: "recovered" } });
      assert.equal(received.at(-1).request.source, "recovered edit");
      client.compile({ input: "bfbs", source: new Uint8Array([1]) });
      const oldMode = workers[1].requests.at(-1);
      client.compile({ source: "table Fresh {}" });
      workers[1].onmessage({ data: { id: oldMode.id, error: "obsolete import", fatal: true } });
      assert.ok(workers[1].terminated);
      assert.equal(client.worker, workers[2]);
      assert.equal(workers[2].requests.at(-1).request.source, "table Fresh {}");
      workers[1].onerror({ preventDefault() {} });
      assert.ok(!workers[2].terminated, "Errors from a replaced worker must be ignored");
      workers[2].onmessage({ data: { id: workers[2].requests.at(-1).id, error: "trap", fatal: true } });
      assert.ok(workers[2].terminated);
      client.compile({ source: "table Recovery {}" });
      assert.equal(workers.length, 4);
      client.invalidate();
    } finally { Object.assign(global, saved); }
    for (const [key, schema] of cases) {
      const folder = path.join(directory, key);
      fs.mkdirSync(folder);
      const sample = usageExample(schema, key);
      assert.match(schema.generated, /pub const serialize = Schema\.serialize;/);
      assert.doesNotMatch(schema.generated, /pub const serializeAlloc = Schema\.serializeAlloc;/);
      assert.match(sample.source, /pub fn main/, `${key}: ${sample.note}`);
      fs.writeFileSync(path.join(folder, `${key}.zig`), schema.generated);
      fs.writeFileSync(path.join(folder, "main.zig"), sample.source);
      const result = spawnSync(zig, ["run", "--dep", "flatzz", `-Mroot=${folder}/main.zig`, `-Mflatzz=${flatzz}/src/runtime.zig`], {
        encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${key}: ${result.error || result.stderr}`);
      assert.match(result.stderr, /serialized: \d+ bytes/);
      if (key === "large_payload") {
        const length = Number(result.stderr.match(/serialized: (\d+) bytes/)[1]);
        assert.ok(length > 4096,
          "Comptime sizing must handle payloads larger than the former 4 KiB buffer");
        console.log(`Comptime buffer regression passed: ${length} serialized bytes exceed the former 4 KiB limit.`);
      }
      assert.match(result.stderr, /created:/);
      assert.match(result.stderr, /received:/);
      assert.match(result.stderr, /edited:/);
      if (sample.editable) {
        const before = result.stderr.split("\n").find(line => line.startsWith("received:"));
        const after = result.stderr.split("\n").find(line => line.startsWith("edited:"));
        assert.notEqual(before.replace("received:", ""), after.replace("edited:", ""), `${key}: update must change a printed value`);
      }
    }
    // Compile the public compiler's real output against both serialize target contracts.
    const contracts = path.join(directory, "flight", "serialization_test.zig");
    fs.writeFileSync(contracts, String.raw`const std = @import("std");
const flatzz = @import("flatzz");
const Message = @import("flight.zig").Flight;

test "unified serialize preserves return types bytes and ownership" {
    const value: Message = .{ .mass = 42, .callsign = "pilot" };
    const options: flatzz.WriteOptions = .{ .force_defaults = true };
    const capacity = comptime flatzz.storage.capacityFor(Message.Schema, value, .{});
    var storage: [capacity]u8 align(flatzz.storage_alignment) = undefined;
    const borrowed_result = value.serialize(&storage, options);
    try std.testing.expect(@TypeOf(borrowed_result) == flatzz.BuildError![]u8);
    const bytes = try borrowed_result;
    const owned_result = value.serialize(std.testing.allocator, options);
    try std.testing.expect(
        @TypeOf(owned_result) == (std.mem.Allocator.Error || flatzz.BuildError)!flatzz.Serialized,
    );
    const owned = try owned_result;
    defer owned.deinit(std.testing.allocator);
    try std.testing.expect(!@hasDecl(Message, "serializeAlloc"));
    try std.testing.expectEqualSlices(u8, bytes, owned.bytes);
    try Message.verify(owned.bytes, .{});
    try std.testing.expectEqualStrings("pilot", (try Message.read(owned.bytes)).callsign.?);
    try std.testing.expect(bytes.ptr == storage[storage.len - bytes.len ..].ptr);
}

test "unified serialize retains capacity allocation and packing errors" {
    const value: Message = .{ .mass = 42, .callsign = "pilot" };
    // Deliberately supply no storage to exercise the capacity error.
    var empty: [0]u8 align(flatzz.storage_alignment) = .{};
    try std.testing.expectError(error.NoSpaceLeft, value.serialize(&empty, .{}));
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    try std.testing.expectError(error.OutOfMemory, value.serialize(failing.allocator(), .{}));
    const invalid: Message = .{ .callsign = "\xff" };
    try std.testing.expectError(error.InvalidUtf8, invalid.serialize(std.testing.allocator, .{}));
}
`);
    const result = spawnSync(zig, ["test", "--dep", "flatzz", `-Mroot=${contracts}`, `-Mflatzz=${flatzz}/src/runtime.zig`], {
      encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `Serialization targets: ${result.error || result.stderr}`);
    console.log("Unified serialize passed: exact return/error types, borrowed/owned bytes, cleanup, and failure paths.");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  await require("./worker.cjs")(installed);
  console.log(`Live compiler passed: exact CLI output for ${catalog.schemas.length} official presets; ${cases.length} usage programs compiled and ran; three modes, binary imports, linked files, exact JSON integers, worker recovery; diagnostics, limits, and 100 edits.`);
})().catch(failure => { console.error(failure); process.exitCode = 1; });
