// A consumer worker: only the public artifact and adapter are needed.
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");

const ready = (async () => {
  const { Compiler } = await import(pathToFileURL(workerData.adapterPath));
  const instance = await WebAssembly.instantiate(workerData.module, {});
  return new Compiler(instance);
})();

parentPort.on("message", async request => {
  try {
    const compiler = await ready;
    parentPort.postMessage({ output: compiler.convert(request) });
  } catch (error) {
    parentPort.postMessage({ error: { code: error.code, message: error.message } });
  }
});
