const scalars = {
  Bool: ["bool", "bool"], Byte: ["byte", "i8"], UByte: ["ubyte", "u8"],
  Short: ["short", "i16"], UShort: ["ushort", "u16"], Int: ["int", "i32"],
  UInt: ["uint", "u32"], Long: ["long", "i64"], ULong: ["ulong", "u64"],
  Float: ["float", "f32"], Double: ["double", "f64"], String: ["string", "[]const u8"],
};

/** Preserve integer literals before JSON.parse can round them. Quoted strings stay untouched. */
export function parseSchemaJson(source) {
  return JSON.parse(source.replace(/("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (token, quoted, number) => quoted || /[.eE]/.test(number) || Number.isSafeInteger(Number(number))
      ? token : JSON.stringify(number)));
}

/** Adapt public schema JSON for presentation; read Zig spellings from actual emitted declarations. */
export function schemaModel(json, generated = "") {
  const schema = parseSchemaJson(json);
  const identifier = '(?:@"(?:\\\\.|[^"\\\\])*"|[A-Za-z_][A-Za-z0-9_]*)';
  const declarations = [...generated.matchAll(new RegExp(`^pub const (${identifier}) = struct \\{`, "gm"))];
  if (generated && declarations.length !== schema.objects.length) {
    throw new Error("Generated declarations could not be matched to schema objects.");
  }
  const integer = (value, base) => ["UByte", "UShort", "UInt", "ULong", "UType"].includes(base)
    ? BigInt.asUintN(64, BigInt(value)).toString() : String(value);
  const objects = schema.objects.map((object, index) => {
    const declaration = declarations[index];
    const body = declaration ? generated.slice(declaration.index,
      declarations[index + 1]?.index ?? generated.length) : "";
    const names = [...body.matchAll(new RegExp(`^    (${identifier}): `, "gm"))].map(match => match[1]);
    const fields = object.fields.filter(field => !field.deprecated && field.type.base_type !== "UType"
      && !(field.type.base_type === "Vector" && field.type.element === "UType"))
      .sort((left, right) => left.id - right.id);
    if (generated && names.length !== fields.length) throw new Error("Generated fields could not be matched.");
    return { name: object.name, zig_name: declaration?.[1] || object.name, is_struct: object.is_struct,
      fields: fields.map((field, position) => ({
        ...field, zig_name: names[position] || field.name, field_id: field.id,
        base_type: field.type.base_type, element: field.type.element, type_index: field.type.index,
        fixed_length: field.type.fixed_length,
        default_integer: integer(field.default_integer, field.type.base_type),
        default_real: String(field.default_real),
      })) };
  });
  return { generated, objects, root_index: objects.findIndex(object => object.name === schema.root_table?.name),
    enums: schema.enums.map(enumeration => enumeration.values.map(value => ({
      name: value.name, value: integer(value.value, enumeration.underlying_type.base_type),
    }))) };
}

export function rootObject(schema) {
  return schema.objects[schema.root_index] || schema.objects.find(object => !object.is_struct) || null;
}

/** Schema-only metadata never reports byte positions for a program that has not run. */
export function schemaReport(schema) {
  const root = rootObject(schema);
  if (!root) return null;
  const declaration = schema.generated.split(`pub const ${root.zig_name} = struct {`)[1]?.split(/^};/m)[0] || "";
  return {
    schema_only: true,
    fields: root.fields.slice().sort((left, right) => left.field_id - right.field_id).map(field => {
      const native = declaration.split("\n").find(line => line.startsWith(`    ${field.zig_name}: `));
      const zigType = native?.slice(`    ${field.zig_name}: `.length).replace(/(?: = .*|,)$/, "") || field.base_type;
      const typeName = base => scalars[base]?.[0] || (base === "Obj"
        ? schema.objects[field.type_index]?.name : base === "Union" ? "union" : base);
      const wireType = field.base_type === "Vector" ? `[${typeName(field.element)}]`
        : field.base_type === "Array" ? `[${typeName(field.element)}:${field.fixed_length}]` : typeName(field.base_type);
      return { name: field.name, wire_type: wireType, zig_type: zigType, field_id: field.field_id,
        display: `wire ID ${field.field_id}`, slot: null, payload: null, borrowed: false };
    }),
  };
}

function scalarValue(schema, field, changed = false) {
  if (field.type_index >= 0) {
    const values = schema.enums[field.type_index];
    const initial = values[0]?.value || "0";
    const value = changed ? values.find(candidate => candidate.value !== initial)?.value || initial : initial;
    return `@enumFromInt(${value})`;
  }
  if (field.base_type === "Bool") return changed ? "false" : "true";
  return changed ? "43" : "42";
}

function sampleText(name, changed) {
  const initial = ({ pilot: "Ziguana", label: "sensor", destination: "Mars" })[name] || "sample";
  return JSON.stringify(changed ? initial.toUpperCase() : initial);
}

function objectValue(schema, object, seen = [], changed = false, budget = { remaining: 128 }) {
  if (seen.includes(object)) throw new Error("A required table cycle needs application-specific values.");
  const fields = object.fields.flatMap(field => {
    const value = fieldValue(schema, field, object.is_struct, [...seen, object], changed, budget);
    return value === null ? [] : [`.${field.zig_name} = ${value}`];
  });
  return fields.length ? `.{ ${fields.join(", ")} }` : ".{}";
}

function fieldValue(schema, field, inStruct = false, seen = [], changed = false, budget = { remaining: 128 }) {
  if (--budget.remaining < 0) throw new Error("This graph needs a smaller, application-specific usage example.");
  if (field.base_type === "String") return sampleText(field.name, changed);
  if (scalars[field.base_type]) return scalarValue(schema, field, changed);
  if (field.base_type === "Vector") {
    if (scalars[field.element]) {
      if (field.element === "String") return "&.{ \"sample\" }";
      return `&.{ ${field.element === "Bool" ? changed ? "false, true, false" : "true, false, true" : field.type_index >= 0
        ? scalarValue(schema, field, changed) : changed ? "4, 2, 5" : "3, 1, 4"} }`;
    }
    return field.required ? "&.{}" : null;
  }
  if (field.base_type === "Obj") {
    const object = schema.objects[field.type_index];
    if (object.is_struct || field.required) {
      const value = objectValue(schema, object, seen, changed, budget);
      return object.is_struct ? value : `&${value}`;
    }
  }
  if (field.base_type === "Array") {
    if (field.fixed_length > 64) throw new Error("Large inline arrays need application-specific example values.");
    const element = { ...field, base_type: field.element, fixed_length: 0 };
    const value = fieldValue(schema, element, true, seen, changed, budget);
    if (value === null) throw new Error("This inline array needs application-specific values.");
    return `.{${Array.from({ length: field.fixed_length }, () => value).join(", ")}}`;
  }
  if (inStruct) throw new Error("This struct needs application-specific values.");
  return null;
}

function printView(root, label, binding) {
  const fields = root.fields.filter(field => scalars[field.base_type]);
  if (!fields.length) return `    std.debug.print("${label}: {any}\\n", .{${binding}});`;
  const formats = fields.map(field => `${field.name}=${field.base_type === "String" ? "{s}" : "{any}"}`);
  const values = fields.map(field => `${binding}.${field.zig_name}${field.base_type === "String" ? ' orelse "(none)"' : ""}`);
  return `    std.debug.print(\n        "${label}: ${formats.join(", ")}\\n",\n        .{ ${values.join(", ")} },\n    );`;
}

/** A complete fixed-buffer Zig program tailored to the current, real generated module. */
export function usageExample(schema, filename) {
  const root = rootObject(schema);
  if (!root) return { source: "// Add a table and root_type to generate a usage example.\n", note: "No root table is available." };
  try {
    const budget = { remaining: 128 };
    const initial = root.fields.flatMap(field => {
      const value = fieldValue(schema, field, false, [root], false, budget);
      return value === null ? [] : [`        .${field.zig_name} = ${value},`];
    });
    const assignments = initial.length ? `    const value: Message = .{\n${initial.join("\n")}\n    };`
      : "    const value: Message = .{};";
    const editable = root.fields.find(field => ["Float", "Double", "UInt", "Int", "Short", "UShort", "Long", "ULong", "Byte", "UByte"].includes(field.base_type) && field.type_index < 0)
      || root.fields.find(field => field.base_type === "Bool" || field.base_type === "String")
      || root.fields.find(field => scalars[field.base_type] && schema.enums[field.type_index]?.length > 1)
      || root.fields.find(field => field.base_type === "Vector" && field.element !== "String" && scalars[field.element])
      || root.fields.find(field => field.base_type === "Obj" && schema.objects[field.type_index].is_struct);
    const edit = editable ? `    if (!try Message.update(bytes, .${editable.zig_name}, ${fieldValue(schema, editable, false, [], true)}))\n        return error.MissingField;`
      : "    // This root has no field supported by the simple in-place edit example.\n    // Rebuild to replace child tables or union alternatives.";
    const source = `const std = @import("std");
const flatzz = @import("flatzz");
const generated = @import("${filename}.zig");
const Message = generated.${root.zig_name};

// 1. Create, serialize into caller-owned storage, and print.
pub fn main() !void {
${assignments}
    const capacity = comptime flatzz.storage.capacityFor(Message.Schema, value, .{});
    var storage: [capacity]u8 align(flatzz.storage_alignment) = undefined;
    // Store defaults too, so existing scalar slots can be updated.
    // A buffer target returns borrowed bytes; an allocator target returns an owner.
    const bytes = try value.serialize(&storage, .{ .force_defaults = true });
    std.debug.print("serialized: {d} bytes\\n", .{bytes.len});
    const created = try Message.read(bytes);
${printView(root, "created", "created")}
    try receive(bytes);
}

// 2. Receive mutable bytes, verify, read, edit, and print again.
fn receive(bytes: []u8) !void {
    try Message.verify(bytes, .{});
    const before = try Message.read(bytes);
${printView(root, "received", "before")}

${edit}

    const after = try Message.read(bytes);
${printView(root, "edited", "after")}
}
`;
    return { source, note: "Save beside the generated module with the flatzz import configured. capacityFor derives the buffer bound from the complete native value at comptime. serialize(&storage, options) borrows that storage; serialize(allocator, options) returns an owner that needs result.deinit(allocator). Keep the storage alive for all views. Updates keep the frame size; string replacements must have the same byte length.", editable: editable?.name };
  } catch (failure) {
    return { source: `// ${failure.message}\n// Generated declarations remain available above.\n`, note: failure.message };
  }
}
