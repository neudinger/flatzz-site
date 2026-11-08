const assert = require("node:assert/strict");
const fs = require("node:fs");

(async () => {
  const module = await WebAssembly.compile(fs.readFileSync(process.argv[2]));
  assert.deepEqual(WebAssembly.Module.imports(module), [], "Runtime must not depend on host allocators or WASI");
  const engine = (await WebAssembly.instantiate(module, {})).exports;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  function run(kind, number, text, options = 0) {
    const input = encoder.encode(text);
    new Uint8Array(engine.memory.buffer, engine.inputPointer(), input.length).set(input);
    const status = engine.render(kind, number, input.length, options);
    const report = decoder.decode(new Uint8Array(engine.memory.buffer, engine.reportPointer(), engine.reportLength()));
    assert.equal(status, 0, report);
    return { ...JSON.parse(report), bytes: new Uint8Array(engine.memory.buffer, engine.framePointer(), engine.frameLength()).slice() };
  }
  let checks = 0;
  let capacity;
  for (const kind of [0, 1, 2, 3]) {
    const report = run(kind, 42, "sensor");
    capacity ??= report.capacity;
    assert.equal(report.capacity, capacity, "All presets share the derived maximum bound");
    assert.ok(report.capacity >= report.bytes.length);
    assert.equal(report.length, report.bytes.length);
    assert.equal(report.length + report.unused, report.capacity);
    assert.equal(new DataView(report.bytes.buffer).getUint32(0, true), report.table_start);
    const strings = report.fields.filter(field => field.wire_type === "string");
    assert.equal(strings.length, 1);
    for (const field of strings) {
      assert.equal(field.borrowed, true);
      assert.equal(decoder.decode(report.bytes.subarray(field.payload, field.payload + field.payload_size)), "sensor");
      assert.equal(new DataView(report.bytes.buffer).getUint32(field.payload - 4, true), 6);
      assert.equal(report.bytes[field.payload + field.payload_size], 0);
      assert.equal(field.slot + new DataView(report.bytes.buffer).getUint32(field.slot, true), field.payload - 4);
    }
    checks++;
  }
  const omitted = run(0, 0, "");
  assert.equal(omitted.fields.find(field => field.name === "value").slot, null);
  const stored = run(0, 0, "", 1);
  assert.notEqual(stored.fields.find(field => field.name === "value").slot, null);
  checks++;
  const rocket = run(1, 100, "pilot");
  assert.equal(rocket.fields.find(field => field.name === "fuel").slot, null);
  const payload = rocket.fields.find(field => field.name === "payload");
  assert.deepEqual([...rocket.bytes.subarray(payload.payload, payload.payload + payload.payload_size)], [3, 1, 4, 1, 5]);
  checks++;
  const mission = run(2, 400, "Lunar survey");
  assert.deepEqual(mission.fields.map(field => field.name), ["name", "position"]);
  const position = mission.fields.find(field => field.name === "position");
  assert.equal(position.inline_value, true);
  assert.equal(position.width, 12);
  const missionBytes = new DataView(mission.bytes.buffer);
  assert.deepEqual([0, 4, 8].map(offset => missionBytes.getFloat32(position.slot + offset, true)),
    [12.5, -3.25, 400]);
  checks++;
  const monster = run(3, 80, "Orc");
  assert.deepEqual(monster.fields.map(field => field.name),
    ["pos", "mana", "hp", "name", "inventory", "color", "test"]);
  const health = monster.fields.find(field => field.name === "hp");
  assert.equal(new DataView(monster.bytes.buffer).getInt16(health.slot, true), 80);
  assert.equal(monster.fields.find(field => field.name === "mana").slot, null);
  assert.equal(monster.fields.find(field => field.name === "mana").display, "150");
  assert.equal(monster.fields.find(field => field.name === "color").display, "green");
  const union = monster.fields.find(field => field.name === "test");
  assert.equal(union.display, "weapon");
  const monsterBytes = new DataView(monster.bytes.buffer);
  const tagOffset = monsterBytes.getUint16(monster.vtable_start + 4 + 7 * 2, true);
  assert.equal(monster.bytes[monster.table_start + tagOffset], 2, "Weapon union discriminator");
  assert.ok(monsterBytes.getUint32(union.slot, true) > 0, "Weapon has a forward table offset");
  checks++;
  const unicode = run(0, 1.5, "飛行🦎");
  assert.equal(unicode.fields.find(field => field.name === "label").payload_size, encoder.encode("飛行🦎").length);
  checks++;
  const memorySize = engine.memory.buffer.byteLength;
  for (let iteration = 0; iteration < 500; iteration++) run(iteration % 4, iteration, "stable");
  assert.equal(engine.memory.buffer.byteLength, memorySize, "Repeated fixed-buffer runtime calls must not grow memory");
  checks++;
  assert.equal(engine.inputCapacity(), 128, "The public UTF-8 input limit is preserved");
  for (let length = 0; length <= engine.inputCapacity(); length++) {
    for (const kind of [0, 1, 2, 3]) for (const options of [0, 1]) {
      // Control bytes require maximal JSON escaping and exercise every wire alignment.
      const report = run(kind, 42, "\0".repeat(length), options);
      assert.equal(report.capacity, capacity);
      assert.equal(report.length + report.unused, capacity);
      const text = report.fields.find(field => field.wire_type === "string");
      assert.equal(text.display, "\0".repeat(length));
      assert.equal(text.payload_size, length);
    }
  }
  checks++;
  for (const kind of [0, 1, 2, 3]) {
    const extremes = kind === 3 ? [-32768, 32767]
      : [Math.fround(3.4028234663852886e38), -Math.fround(3.4028234663852886e38),
        2 ** -149, -(2 ** -149)];
    for (const number of extremes) run(kind, number, "\\".repeat(engine.inputCapacity()), 1);
  }
  assert.equal(engine.memory.buffer.byteLength, memorySize, "Bounded scratch stays fixed at input extremes");
  checks++;
  for (const [kind, number, length, error] of [[9, 1, 0, "UnknownExample"], [3, 32768, 0, "InvalidInteger"], [3, 1.5, 0, "InvalidInteger"], [0, NaN, 0, "InvalidNumber"], [0, 1, 129, "InputTooLong"]]) {
    assert.equal(engine.render(kind, number, length, 0), 1);
    assert.equal(engine.frameLength(), 0);
    assert.equal(decoder.decode(new Uint8Array(engine.memory.buffer, engine.reportPointer(), engine.reportLength())), error);
    checks++;
  }
  new Uint8Array(engine.memory.buffer, engine.inputPointer(), 1)[0] = 255;
  assert.equal(engine.render(0, 1, 1, 0), 1);
  assert.equal(decoder.decode(new Uint8Array(engine.memory.buffer, engine.reportPointer(), engine.reportLength())), "InvalidUtf8");
  checks++;
  run(0, 42, "recovered");
  checks++;
  console.log(`${checks} generated-code/Wasm checks passed; derived message capacity ${capacity} B; 1,032 text/default boundaries and 14 numeric extremes passed; 500 repeated calls kept memory fixed.`);
  await require("./rocket.cjs")(module);
})().catch(failure => { console.error(failure); process.exitCode = 1; });
