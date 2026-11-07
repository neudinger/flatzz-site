import { schemaModel } from "./schema-model.js?v=comptime-buffers-1";

/** The shared compiler owns every conversion. This layer only prepares optional site views. */
export function convertRequest(compiler, request) {
  const output = compiler.convert(request);
  let schema = null;
  let note = "";
  try {
    const json = request.output === "json" ? output : compiler.convert({ ...request, output: "json" });
    schema = schemaModel(json, request.output === "json" ? "" : output);
  } catch {
    note = "The output is available. A field preview could not be prepared for this schema.";
  }
  return { output, schema, note, limits: compiler.limits };
}

export function diagnosticMessage(error) {
  const position = error.line ? `${error.filename}:${error.line}:${error.column}: ` : "";
  return position + (error instanceof WebAssembly.RuntimeError
    ? "The compiler reached its browser resource limit. Reduce the schema and try again."
    : error.message);
}
