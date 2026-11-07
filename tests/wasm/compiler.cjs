// Exercise the public Wasm ABI and JavaScript adapter against the native compiler.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { test, after } = require("node:test");
const { Worker } = require("node:worker_threads");

const [wasmPath, adapterPath, nativePath, zig, repository] = process.argv.slice(2);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function main() {
  const { Compiler, CompilerError } = await import(pathToFileURL(adapterPath));
  const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {});
  const engine = instance.exports;
  const compiler = new Compiler(instance);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flatzz-wasm-test-"));
  after(() => fs.rmSync(directory, { recursive: true, force: true }));

  function execute(command, arguments) {
    const result = spawnSync(command, arguments, { maxBuffer: 32 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  }

  function writeProject(request) {
    const filename = request.filename || "schema.fbs";
    for (const [name, source] of Object.entries({ [filename]: request.source, ...request.files })) {
      const destination = path.join(directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, source);
    }
    return path.join(directory, filename);
  }

  function native(format, filename) {
    return execute(nativePath, [`--${format}`, filename]);
  }

  function normalizePaths(json) {
    const prefix = JSON.stringify(directory + path.sep).slice(1, -1);
    return json.replaceAll(prefix, "");
  }

  function expectCompilerError(operation, status, code) {
    assert.throws(operation, error => {
      assert.ok(error instanceof CompilerError, error.stack);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(engine.outputLength(), 0, "Failures must clear previous output.");
  }

  function rawInput(bytes) {
    new Uint8Array(engine.memory.buffer, engine.inputPointer(), bytes.length).set(bytes);
  }

  function diagnostic() {
    return JSON.parse(decoder.decode(new Uint8Array(engine.memory.buffer,
      engine.diagnosticPointer(), engine.diagnosticLength())));
  }

  const fixtures = [
    { key: "rocket", example: "readme", filename: "rocket.fbs",
      source: fs.readFileSync(path.join(repository, "example/readme/rocket.fbs"), "utf8") },
    { key: "mission", example: "mission", filename: "mission/mission.fbs",
      source: fs.readFileSync(path.join(repository, "example/flatbuf/mission/mission.fbs"), "utf8"),
      files: { "mission/common.fbs": fs.readFileSync(
        path.join(repository, "example/flatbuf/mission/common.fbs"), "utf8") } },
    { key: "monster", example: "monster", filename: "monster.fbs",
      source: fs.readFileSync(path.join(repository, "example/flatbuf/monster.fbs"), "utf8") },
  ];

  test("ABI v1 exports memory, explicit limits, and no host or WASI imports", () => {
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    assert.equal(engine.abiVersion(), 1);
    assert.ok(engine.memory instanceof WebAssembly.Memory);
    assert.equal(compiler.limits.input_bytes, engine.inputCapacity());
    assert.deepEqual(compiler.limits, {
      input_bytes: 1024 * 1024, source_bytes: 1024 * 1024,
      workspace_bytes: 32 * 1024 * 1024, files: 64, path_bytes: 1024,
      depth: 32, objects: 100000, work_bytes: 16 * 1024 * 1024,
    });
    assert.throws(() => new Compiler({ exports: { abiVersion: () => 2 } }), /ABI/);
  });

  for (const fixture of fixtures) {
    test(`${fixture.key}: all five conversions match native results`, () => {
      const filename = writeProject(fixture);
      const source = compiler.convert(fixture);
      assert.equal(source, native("zig", filename).toString());
      const json = compiler.convert({ ...fixture, output: "json" });
      // Native filenames are absolute; virtual project filenames are relative.
      assert.equal(json, normalizePaths(native("json", filename).toString()));
      const binary = compiler.convert({ ...fixture, output: "bfbs" });
      assert.ok(binary instanceof Uint8Array);
      assert.equal(decoder.decode(binary.subarray(4, 8)), "BFBS");
      assert.equal(compiler.convert({ input: "bfbs", source: binary }), source);
      assert.equal(compiler.convert({ input: "bfbs", source: binary, output: "json" }), json);
      const binaryPath = path.join(directory, `${fixture.key}.bfbs`);
      fs.writeFileSync(binaryPath, binary);
      assert.equal(native("zig", binaryPath).toString(), source);
      assert.equal(native("json", binaryPath).toString(), json);
      const nativeBinary = native("bfbs", filename);
      assert.equal(compiler.convert({ input: "bfbs", source: nativeBinary }), source);
      assert.equal(compiler.convert({ input: "bfbs", source: nativeBinary, output: "json" }),
        native("json", filename).toString());
    });

    test(`${fixture.key}: emitted Zig passes the example's real round-trip tests`, () => {
      const generatedPath = path.join(directory, `${fixture.key}.zig`);
      fs.writeFileSync(generatedPath, compiler.convert(fixture));
      execute(zig, ["test", "--dep", "flatzz", "--dep", fixture.key,
        `-Mroot=${path.join(repository, `example/${fixture.example}/main.zig`)}`,
        "--dep", "flatzz", `-M${fixture.key}=${generatedPath}`,
        `-Mflatzz=${path.join(repository, "src/runtime.zig")}`]);
    });
  }

  test("source maps normalize relative includes, deduplicate aliases, and retain origins", () => {
    const json = compiler.convert({ output: "json", filename: "nested/./main.fbs",
      source: 'include "../common.fbs"; include ".././common.fbs"; ' +
        'table Root { pos:Position; } root_type Root;',
      files: { "common.fbs": "struct Position { east:float; }" } });
    const schema = JSON.parse(json);
    assert.equal(schema.fbs_files.length, 2);
    assert.equal(schema.root_table.name, "Root");
    assert.equal(schema.root_table.declaration_file, "nested/main.fbs");
    assert.equal(schema.objects.find(object => object.name === "Position").declaration_file,
      "common.fbs");
    expectCompilerError(() => compiler.convert({ source: 'include "missing.fbs";' }),
      2, "IncludeNotFound");
    for (const filename of ["../bad.fbs", "/bad.fbs", "dir\\bad.fbs", "bad\0.fbs", "."]) {
      expectCompilerError(() => compiler.convert({ filename, source: "" }), 1, "InvalidPath");
    }
    expectCompilerError(() => compiler.convert({ source: "", files: { "./schema.fbs": "" } }),
      1, "DuplicateSource");
  });

  test("schema JSON preserves 64-bit integers and nonfinite defaults as native does", () => {
    const request = { filename: "numbers.fbs", source:
      "table Numbers { precise:long = 9007199254740993; maximum:ulong = 18446744073709551615;" +
      " positive:double = inf; negative:double = -inf; missing:double = nan; } root_type Numbers;" };
    const json = compiler.convert({ ...request, output: "json" });
    assert.match(json, /"default_integer": 9007199254740993/);
    assert.match(json, /"default_integer": -1/);
    for (const value of ["inf", "-inf", "nan"]) assert.ok(json.includes(`"${value}"`));
    assert.equal(json, normalizePaths(native("json", writeProject(request)).toString()));
    const binary = compiler.convert({ ...request, output: "bfbs" });
    assert.equal(compiler.convert({ input: "bfbs", source: binary, output: "json" }), json);
  });

  test("FBS failures expose structured diagnostics and recover on the next request", () => {
    compiler.convert(fixtures[0]);
    assert.throws(() => compiler.convert({ filename: "broken.fbs",
      source: "table Broken { value:Missing; }" }), error => {
      assert.ok(error instanceof CompilerError);
      assert.equal(error.status, 2);
      assert.equal(error.filename, "broken.fbs");
      assert.equal(error.line, 1);
      assert.ok(error.column > 0);
      return true;
    });
    assert.equal(engine.outputLength(), 0);
    expectCompilerError(() => compiler.convert({ source: "rpc_service Service {}" }),
      3, "UnsupportedFeature");
    assert.match(compiler.convert(fixtures[0]), /pub const Rocket/);
    assert.deepEqual(diagnostic(), {});
  });

  test("malformed BFBS is rejected, and typed-array offsets and ArrayBuffers are respected", () => {
    expectCompilerError(() => compiler.convert({ input: "bfbs", source: new Uint8Array([1, 2]) }),
      2, "InvalidBfbs");
    const binary = compiler.convert({ ...fixtures[0], output: "bfbs" });
    const corrupt = binary.slice();
    corrupt[4] ^= 1;
    expectCompilerError(() => compiler.convert({ input: "bfbs", source: corrupt }),
      2, "InvalidBfbs");
    const padded = new Uint8Array(binary.length + 11);
    padded.set(binary, 7);
    const expected = compiler.convert(fixtures[0]);
    assert.equal(compiler.convert({ input: "bfbs", source: padded.subarray(7, -4) }), expected);
    assert.equal(compiler.convert({ input: "bfbs", source: binary.slice().buffer }), expected);
  });

  test("schema inspection remains available when Zig generation rejects exported names", () => {
    const request = { source: "table Root { Schema:uint; } root_type Root;" };
    assert.match(compiler.convert({ ...request, output: "json" }), /"name": "Schema"/);
    expectCompilerError(() => compiler.convert(request), 2, "NameCollision");
    const binary = compiler.convert({ ...request, output: "bfbs" });
    expectCompilerError(() => compiler.convert({ input: "bfbs", source: binary }),
      2, "NameCollision");
    assert.match(compiler.convert({ input: "bfbs", source: binary, output: "json" }), /Schema/);
  });

  test("raw ABI rejects invalid selectors, overflowing lengths, and invalid UTF-8", () => {
    engine.reset();
    assert.equal(engine.convert(9, 0, 0), 1);
    assert.equal(diagnostic().code, "InvalidFormat");
    assert.equal(engine.convert(0, 9, 0), 1);
    assert.equal(engine.convert(1, 2, 0), 1);
    assert.equal(engine.convert(1, 0, 0xffffffff), 4);
    assert.equal(diagnostic().code, "InputTooLarge");
    assert.equal(engine.addFile(0xffffffff, 1), 4);
    assert.equal(engine.addFile(1, 0xffffffff), 4);
    rawInput(new Uint8Array([255]));
    assert.equal(engine.addFile(1, 0), 1);
    assert.equal(diagnostic().code, "InvalidUtf8");
    rawInput(new Uint8Array([97, 255]));
    assert.equal(engine.addFile(1, 1), 1);
    assert.equal(engine.outputLength(), 0);
    engine.reset();
    assert.deepEqual(diagnostic(), {});
  });

  test("file count, source bytes, path length, and include depth are bounded", () => {
    const files = Object.fromEntries(Array.from({ length: compiler.limits.files },
      (_, index) => [`file_${index}.fbs`, ""]));
    expectCompilerError(() => compiler.convert({ source: "", files }), 4, "TooManySources");
    expectCompilerError(() => compiler.convert({ source: " ".repeat(600000),
      files: { "large.fbs": " ".repeat(600000) } }), 4, "SourceLimitExceeded");
    expectCompilerError(() => compiler.convert({ filename: "a".repeat(1025), source: "" }),
      4, "PathTooLong");
    const chain = {};
    for (let index = 1; index <= compiler.limits.depth; index++) {
      chain[`file_${index}.fbs`] = index === compiler.limits.depth ? "" :
        `include "file_${index + 1}.fbs";`;
    }
    expectCompilerError(() => compiler.convert({ filename: "file_0.fbs",
      source: 'include "file_1.fbs";', files: chain }), 4, "DepthLimitExceeded");
    assert.match(compiler.convert(fixtures[0]), /pub const Rocket/);
  });

  test("compiler workspace exhaustion returns an error without trapping", () => {
    const fields = Array.from({ length: 30000 }, (_, index) => `field_${index}:uint;`).join(" ");
    for (const output of ["zig", "json", "bfbs"]) {
      expectCompilerError(() => compiler.convert({ source: `table Large { ${fields} }`, output }),
        4, "OutOfMemory");
    }
    assert.match(compiler.convert(fixtures[0]), /pub const Rocket/);
  });

  test("adapter validates formats and source types before using the ABI", () => {
    for (const input of ["unknown", "toString"]) {
      assert.throws(() => compiler.convert({ input, source: "" }), TypeError);
    }
    assert.throws(() => compiler.convert({ output: "unknown", source: "" }), TypeError);
    assert.throws(() => compiler.convert({ input: "bfbs", output: "bfbs", source: new Uint8Array() }),
      TypeError);
    assert.throws(() => compiler.convert({ input: "bfbs", source: "" }), TypeError);
    assert.throws(() => compiler.convert({ input: "bfbs", source: new Uint8Array(),
      files: { "extra.fbs": "" } }), TypeError);
    assert.throws(() => compiler.convert({ source: null }), TypeError);
    assert.throws(() => compiler.convert({ source: "", files: [] }), TypeError);
    assert.throws(() => compiler.convert({ source: " ".repeat(engine.inputCapacity()) }), RangeError);
  });

  test("repeated mixed requests keep memory fixed and preserve copied BFBS output", () => {
    const binary = compiler.convert({ ...fixtures[0], output: "bfbs" });
    const saved = binary.slice();
    const memorySize = engine.memory.buffer.byteLength;
    for (let index = 0; index < 100; index++) {
      const fixture = fixtures[index % fixtures.length];
      assert.match(compiler.convert(fixture), /Generated by flatzz/);
      assert.match(compiler.convert({ input: "bfbs", source: binary, output: "json" }), /Rocket/);
    }
    assert.equal(engine.memory.buffer.byteLength, memorySize);
    assert.deepEqual(binary, saved);
    engine.reset();
    rawInput(encoder.encode("schema.fbs"));
    assert.equal(engine.convert(0, 0, 10), 2, "Reset must discard the previous source map.");
    assert.equal(diagnostic().code, "IncludeNotFound");
  });

  test("a consumer can use the adapter in a worker and recover after invalid input", async () => {
    const worker = new Worker(path.join(__dirname, "worker.cjs"), {
      workerData: { module, adapterPath: path.resolve(adapterPath) },
    });
    async function request(value) {
      const response = new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      worker.postMessage(value);
      return response;
    }
    try {
      const failure = await request({ source: "table Broken { invalid:Missing; }" });
      assert.equal(failure.error.code, "InvalidSchema");
      assert.match((await request(fixtures[1])).output, /pub const Mission/);
      const binary = compiler.convert({ ...fixtures[0], output: "bfbs" });
      assert.match((await request({ input: "bfbs", source: binary })).output, /pub const Rocket/);
    } finally {
      await worker.terminate();
    }
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
