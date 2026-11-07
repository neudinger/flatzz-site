import { Compiler } from "./compiler.mjs?v=comptime-buffers-1";
import { convertRequest, diagnosticMessage } from "./compiler-service.js?v=comptime-buffers-1";

const ready = WebAssembly.instantiateStreaming(
  fetch(new URL("./flatzz-compiler.wasm?v=comptime-buffers-1", import.meta.url)), {},
).then(module => new Compiler(module.instance));

self.onmessage = async ({ data: { id, request } }) => {
  let compiler;
  try {
    compiler = await ready;
    self.postMessage({ id, result: convertRequest(compiler, request) });
  } catch (failure) {
    self.postMessage({ id, error: diagnosticMessage(failure),
      fatal: !compiler || failure instanceof WebAssembly.RuntimeError });
  }
};
