/** Flatzz compiler ABI v1 adapter, usable in browser workers and Node.js. */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const inputFormats = Object.freeze({ fbs: 0, bfbs: 1 });
const outputFormats = Object.freeze({ zig: 0, json: 1, bfbs: 2 });

export class CompilerError extends Error {
  constructor(diagnostic) {
    super(diagnostic.message);
    this.name = "CompilerError";
    Object.assign(this, diagnostic);
  }
}

export class Compiler {
  /** Instantiate the Wasm module with an empty imports object, then pass its instance. */
  constructor(instance) {
    this.engine = instance.exports;
    if (this.engine.abiVersion() !== 1) throw new Error("Unsupported Flatzz compiler ABI.");
    this.limits = Object.freeze(JSON.parse(this.text("limits")));
  }

  /**
   * FBS: { source: text, filename?: "schema.fbs", files?: { "common.fbs": text } }.
   * BFBS: { input: "bfbs", source: Uint8Array | ArrayBuffer }.
   * output is "zig" (default), "json" (schema metadata), or "bfbs" (FBS only).
   * Returned text or copied binary survives subsequent conversions. Errors carry
   * status/code/filename/line/column; diagnostic columns count UTF-8 bytes.
   * Instances are synchronous and non-reentrant; run one per worker for isolation.
   */
  convert({ input = "fbs", output = "zig", source, filename = "schema.fbs", files = {} }) {
    if (!Object.hasOwn(inputFormats, input) || !Object.hasOwn(outputFormats, output) ||
        (input === "bfbs" && output === "bfbs")) {
      throw new TypeError("Invalid Flatzz input/output format.");
    }
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      throw new TypeError("FBS files must be an object mapping filenames to source text.");
    }
    this.engine.reset();
    let bytes;
    if (input === "fbs") {
      this.addFile(filename, source);
      for (const [name, text] of Object.entries(files)) this.addFile(name, text);
      bytes = encoder.encode(filename);
    } else {
      if (Object.keys(files).length) throw new TypeError("BFBS input does not use include files.");
      if (!(source instanceof Uint8Array) && !(source instanceof ArrayBuffer)) {
        throw new TypeError("BFBS input must be a Uint8Array or ArrayBuffer.");
      }
      bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    }
    this.writeInput(bytes);
    this.check(this.engine.convert(inputFormats[input], outputFormats[output], bytes.length));
    const result = this.view("output");
    return output === "bfbs" ? result.slice() : decoder.decode(result);
  }

  addFile(name, source) {
    if (typeof name !== "string" || typeof source !== "string") {
      throw new TypeError("FBS filenames and source text must be strings.");
    }
    const nameBytes = encoder.encode(name);
    const sourceBytes = encoder.encode(source);
    this.writeInput(nameBytes, sourceBytes);
    this.check(this.engine.addFile(nameBytes.length, sourceBytes.length));
  }

  writeInput(...parts) {
    const length = parts.reduce((total, part) => total + part.length, 0);
    if (length > this.engine.inputCapacity()) {
      throw new RangeError(`Compiler input exceeds ${this.engine.inputCapacity()} bytes.`);
    }
    const target = new Uint8Array(this.engine.memory.buffer, this.engine.inputPointer(), length);
    let position = 0;
    for (const part of parts) {
      target.set(part, position);
      position += part.length;
    }
  }

  view(name) {
    return new Uint8Array(this.engine.memory.buffer,
      this.engine[`${name}Pointer`](), this.engine[`${name}Length`]());
  }

  text(name) {
    return decoder.decode(this.view(name));
  }

  check(status) {
    if (status !== 0) throw new CompilerError(JSON.parse(this.text("diagnostic")));
  }
}
