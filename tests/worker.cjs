const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

// Run the actual browser worker with local file-backed fetch and a message bridge.
module.exports = async function checkWorker(installed) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const { pathToFileURL } = require("node:url");
    global.self = { postMessage: value => parentPort.postMessage(value) };
    global.fetch = async url => new Response(fs.readFileSync(url), {
      headers: { "Content-Type": "application/wasm" },
    });
    const ready = import(pathToFileURL(workerData));
    parentPort.on("message", async data => { await ready; await self.onmessage({ data }); });
  `, { eval: true, workerData: path.join(installed, "assets/compiler-worker.js") });
  let identifier = 0;
  async function request(value) {
    const id = ++identifier;
    const result = new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    worker.postMessage({ id, request: value });
    const response = await result;
    assert.equal(response.id, id);
    return response;
  }
  try {
    const source = "table Flight { mass:double; } root_type Flight;";
    assert.match((await request({ source, output: "zig" })).result.output, /pub const Flight/);
    const json = await request({ source, output: "json" });
    assert.equal(JSON.parse(json.result.output).root_table.name, "Flight");
    const binary = fs.readFileSync(path.join(installed, "examples/generated/readme/rocket.bfbs"));
    assert.match((await request({ input: "bfbs", output: "zig", source: binary })).result.output,
      /pub const Rocket/);
    assert.match((await request({ input: "bfbs", output: "zig", source: new Uint8Array([1]) })).error,
      /InvalidBfbs/);
    assert.match((await request({ source, output: "zig" })).result.output, /pub const Flight/);
  } finally { await worker.terminate(); }
};
