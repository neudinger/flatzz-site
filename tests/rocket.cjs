const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function checkRocket(wasm) {
  const source = fs.readFileSync(path.join(__dirname, "../assets/rocket-model.js"), "utf8");
  const { rocketFields, rocketLayout, rocketPartAt } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const engine = (await WebAssembly.instantiate(wasm, {})).exports;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let fieldsChecked = 0;
  for (const [kind, number, text] of [[0, 42, "飛行🦎"], [1, 75, "Ziguana"], [2, 400, "Lunar survey"], [3, 80, "Orc"]]) {
    const input = encoder.encode(text);
    new Uint8Array(engine.memory.buffer, engine.inputPointer(), input.length).set(input);
    assert.equal(engine.render(kind, number, input.length, 0), 0);
    const report = JSON.parse(decoder.decode(new Uint8Array(engine.memory.buffer, engine.reportPointer(), engine.reportLength())));
    const bytes = new Uint8Array(engine.memory.buffer, engine.framePointer(), engine.frameLength());
    for (const field of rocketFields(report)) {
      assert.ok(field.zigType.length);
      assert.ok(!field.value.includes("e0"), "Numeric stage labels should be readable decimal values");
      if (field.slot === null) {
        const absent = ["null", "none"].includes(field.display);
        assert.equal(field.access, absent ? "Absent value" : "Default value");
        assert.match(field.location, /no stored slot/);
      } else if (field.payload !== null) {
        assert.match(field.location, new RegExp(`payload \\+${field.payload} · ${field.payload_size} B`));
        assert.equal(field.access, "Borrowed bytes");
        if (field.wire_type === "string") {
          assert.equal(decoder.decode(bytes.subarray(field.payload, field.payload + field.payload_size)), text);
          assert.equal(field.value, JSON.stringify(text));
        }
      } else {
        assert.equal(field.access, field.borrowed ? "Borrowed bytes" : "Scalar by value");
        assert.match(field.location, new RegExp(`frame \\+${field.slot}`));
      }
      fieldsChecked++;
    }
  }
  let layouts = 0;
  for (const width of [288, 358, 430, 620]) for (const count of [2, 4, 7, 11]) for (const separation of [0, .5, 1]) {
    const height = Math.max(410, 205 + count * 68);
    const layout = rocketLayout(count, width, height, separation);
    assert.equal(rocketPartAt(layout, layout.center, layout.nose.y + 30), "root");
    assert.equal(rocketPartAt(layout, 0, 0), null);
    for (const stage of layout.stages) {
      assert.equal(rocketPartAt(layout, stage.x, stage.y + stage.height / 2), stage.index);
      assert.ok(stage.label.x >= 0 && stage.label.x + stage.label.width <= width);
      assert.ok(stage.label.y >= 0 && stage.label.y + stage.label.height <= height);
      for (const other of layout.stages) {
        if (stage.index >= other.index) continue;
        const left = stage.label, right = other.label;
        assert.ok(left.x + left.width <= right.x || right.x + right.width <= left.x
          || left.y + left.height <= right.y || right.y + right.height <= left.y, "Field controls must not overlap");
      }
    }
    assert.ok(layout.engine.y + 70 <= height, "Exhaust must remain inside the canvas");
    layouts++;
  }
  console.log(`Rocket checks passed: ${fieldsChecked} real generated fields; ${layouts} responsive/assembled layouts.`);
};
