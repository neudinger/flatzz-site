//! Official generated types serialize into a comptime-sized buffer in the browser.
//! All output slices and inspection records expire at the next render call.
//! Source generation happens at build time; this bridge never allocates.
const std = @import("std");
const flatzz = @import("flatzz");
const reading = @import("reading");
const rocket = @import("rocket");
const mission = @import("mission");
const monster = @import("monster");

const Field = struct {
    name: []const u8,
    wire_type: []const u8,
    slot: ?usize = null,
    width: usize = 4,
    payload: ?usize = null,
    payload_size: usize = 0,
    display: []const u8 = "null",
    borrowed: bool = false,
    inline_value: bool = false,
};

// Public input limit, in UTF-8 bytes. Message capacity is derived separately.
const max_text_bytes = 128;
const bounded_text: [max_text_bytes]u8 = @splat('x');
const weapon: monster.Weapon = .{};
// Complete native graphs bound every accepted runtime number and text length.
const examples = .{
    reading.Reading{
        .sequence = 41,
        .value = 0,
        .label = &bounded_text,
        .status = .ok,
        .temperature = 20,
        .samples = &.{ 1, 2, 3 },
        .tags = &.{ "lab", "new" },
        .location = .{
            .coordinates = .{ .latitude = 48.5, .longitude = 2.25 },
            .altitude = 35,
        },
    },
    rocket.Rocket{
        .id = 42,
        .fuel = 0,
        .pilot = &bounded_text,
        .payload = &.{ 3, 1, 4, 1, 5 },
    },
    mission.Mission{
        .name = &bounded_text,
        .position = .{ .east = 12.5, .north = -3.25, .altitude = 0 },
    },
    monster.Monster{
        .name = &bounded_text,
        .pos = .{ .x = 1, .y = 2, .z = 3 },
        .hp = 0,
        .color = .green,
        .inventory = &.{ 1, 2, 3 },
        .@"test" = .{ .weapon = &weapon },
    },
};
const limits = limits_blk: {
    var largest: struct {
        message: usize = 0,
        fields: usize = 0,
        name: usize = 0,
        wire_type: usize = 0,
        display: usize,
    } = .{
        .display = @max(
            std.fmt.float.bufferSize(.scientific, f32),
            std.fmt.count("inline struct · {d} B", .{std.math.maxInt(usize)}),
            std.fmt.count("{d} elements", .{std.math.maxInt(usize)}),
        ),
    };
    for (examples) |value| {
        const Native = @TypeOf(value);
        const capacity = flatzz.storage.capacityFor(Native.Schema, value, .{});
        largest.message = @max(largest.message, capacity);
        const names = std.meta.fieldNames(Native);
        largest.fields = @max(largest.fields, names.len);
        for (names) |name| {
            const Descriptor = @field(Native.Schema.fields, name);
            largest.name = @max(largest.name, name.len);
            largest.wire_type = @max(largest.wire_type, @tagName(Descriptor.kind).len);
            switch (Descriptor.kind) {
                .scalar => |Value| {
                    const Scalar = switch (@typeInfo(Value)) {
                        .optional => |optional| optional.child,
                        else => Value,
                    };
                    largest.wire_type = @max(largest.wire_type, scalarName(Scalar).len);
                    if (@typeInfo(Value) == .@"enum")
                        largest.display = @max(largest.display, @tagName(@field(value, name)).len);
                },
                .union_value => {
                    largest.display = @max(largest.display, @tagName(@field(value, name)).len);
                },
                else => {},
            }
        }
    }
    break :limits_blk largest;
};

const Report = struct {
    example: u32,
    capacity: usize,
    length: usize,
    unused: usize,
    table_start: usize,
    table_size: usize,
    vtable_start: usize,
    vtable_size: usize,
    fields: []const Field,
};

// Count a worst-case JSON record: control bytes escape to six bytes each;
// maximum integers and non-null offsets bound every shorter numeric/null value.
const report_capacity = report_capacity_blk: {
    @setEvalBranchQuota(1_000_000);
    const name: [limits.name]u8 = @splat(0);
    const wire_type: [limits.wire_type]u8 = @splat(0);
    const display: [@max(bounded_text.len, limits.display)]u8 = @splat(0);
    const maximum = std.math.maxInt(usize);
    const field: Field = .{
        .name = &name,
        .wire_type = &wire_type,
        .slot = maximum,
        .width = maximum,
        .payload = maximum,
        .payload_size = maximum,
        .display = &display,
    };
    const records: [limits.fields]Field = @splat(field);
    const value: Report = .{
        .example = std.math.maxInt(u32),
        .capacity = maximum,
        .length = maximum,
        .unused = maximum,
        .table_start = maximum,
        .table_size = maximum,
        .vtable_start = maximum,
        .vtable_size = maximum,
        .fields = &records,
    };
    var counter: std.Io.Writer.Discarding = .init(&.{});
    std.json.Stringify.value(value, .{}, &counter.writer) catch |failure|
        @compileError(@errorName(failure));
    break :report_capacity_blk counter.fullCount();
};

var input_buffer: [bounded_text.len]u8 = @splat(0);
var output_buffer: [limits.message]u8 align(flatzz.storage_alignment) = undefined;
var report_buffer: [report_capacity]u8 = undefined;
var display_buffers: [limits.fields][limits.display]u8 = undefined;
var frame: []u8 = &.{};
var report: []const u8 = "{}";
var fields: [limits.fields]Field = undefined;
var field_count: usize = 0;

export fn inputPointer() usize {
    return @intFromPtr(&input_buffer);
}
export fn inputCapacity() usize {
    return input_buffer.len;
}
export fn framePointer() usize {
    return @intFromPtr(frame.ptr);
}
export fn frameLength() usize {
    return frame.len;
}
export fn reportPointer() usize {
    return @intFromPtr(report.ptr);
}
export fn reportLength() usize {
    return report.len;
}

/// Rebuild a compiled example; bit zero stores scalar defaults for later mutation.
/// Return zero on success; failures clear the frame and expose an error name as the report.
export fn render(example: u32, number: f64, text_length: usize, options: u32) u32 {
    frame = &.{};
    field_count = 0;
    report = "{}";
    renderExample(example, number, text_length, options) catch |failure| {
        frame = &.{};
        report = @errorName(failure);
        return 1;
    };
    return 0;
}

fn relative(slice: []const u8) !usize {
    const start = @intFromPtr(slice.ptr);
    const base = @intFromPtr(frame.ptr);
    if (start < base or start - base > frame.len or slice.len > frame.len - (start - base))
        return error.BorrowOutsideFrame;
    return start - base;
}

fn scalarName(comptime Scalar: type) []const u8 {
    return if (Scalar == f32) "float" else if (Scalar == u32) "uint" else @typeName(Scalar);
}

/// Inspect the schema descriptors rather than repeating wire IDs in the bridge.
fn serialize(comptime Native: type, value: Native, options: flatzz.WriteOptions) !void {
    frame = try value.serialize(&output_buffer, options);
    try Native.verify(frame, .{});
    const view = try Native.read(frame);
    const table = try flatzz.Table.from(frame, .root);
    const names = comptime std.meta.fieldNames(Native);
    if (comptime names.len > fields.len) @compileError("runtime report field capacity exceeded");
    inline for (names) |name| {
        const Descriptor = @field(Native.Schema.fields, name);
        const current = @field(view, name);
        var field: Field = .{ .name = name, .wire_type = @tagName(Descriptor.kind) };
        const display = &display_buffers[field_count];
        switch (Descriptor.kind) {
            .scalar => |Value| {
                const Scalar = switch (@typeInfo(Value)) {
                    .optional => |optional| optional.child,
                    else => Value,
                };
                field.wire_type = scalarName(Scalar);
                field.width = @sizeOf(Scalar);
                field.slot = try table.fieldPosition(Scalar, Descriptor.wire_id);
                field.display = if (@typeInfo(Value) == .@"enum")
                    @tagName(current)
                else
                    try std.fmt.bufPrint(display, "{any}", .{current});
            },
            .string => {
                field.slot = try table.fieldPosition(u32, Descriptor.wire_id);
                if (current) |text| {
                    field.payload = try relative(text);
                    field.payload_size = text.len;
                    field.display = text;
                    field.borrowed = true;
                }
            },
            .structure => |Layout| {
                field.width = Layout.wire_size;
                if (current) |structure| {
                    field.slot = structure.struct_start;
                    field.inline_value = true;
                    field.borrowed = true;
                    field.display = try std.fmt.bufPrint(display, "inline struct · {d} B", .{
                        Layout.wire_size,
                    });
                }
            },
            .vector => |Codec| {
                field.slot = try table.fieldPosition(u32, Descriptor.wire_id);
                if (current) |vector| {
                    const stride = switch (Codec.kind) {
                        .string, .table => 4,
                        else => Codec.slot_size,
                    };
                    field.payload = vector.payload_start;
                    field.payload_size = vector.element_count * stride;
                    field.display = try std.fmt.bufPrint(display, "{d} elements", .{
                        vector.element_count,
                    });
                    field.borrowed = true;
                }
            },
            .union_value => {
                field.slot = try table.fieldPosition(u32, Descriptor.wire_id);
                field.display = @tagName(current);
                field.borrowed = field.slot != null;
            },
            else => @compileError("add inspection for the new official example field kind"),
        }
        fields[field_count] = field;
        field_count += 1;
    }
}

fn renderExample(example: u32, number: f64, text_length: usize, options: u32) !void {
    if (text_length > input_buffer.len) return error.InputTooLong;
    const text = input_buffer[0..text_length];
    if (!std.unicode.utf8ValidateSlice(text)) return error.InvalidUtf8;
    if (!std.math.isFinite(number)) return error.InvalidNumber;
    const write_options: flatzz.WriteOptions = .{ .force_defaults = options & 1 != 0 };
    const decimal: f32 = @floatCast(number);
    if (!std.math.isFinite(decimal)) return error.InvalidNumber;
    switch (example) {
        0 => {
            var value = examples[0];
            value.value = decimal;
            value.label = text;
            try serialize(reading.Reading, value, write_options);
        },
        1 => {
            var value = examples[1];
            value.fuel = decimal;
            value.pilot = text;
            try serialize(rocket.Rocket, value, write_options);
        },
        2 => {
            var value = examples[2];
            value.name = text;
            value.position.?.altitude = decimal;
            try serialize(mission.Mission, value, write_options);
        },
        3 => {
            if (number < std.math.minInt(i16) or number > std.math.maxInt(i16) or
                @trunc(number) != number) return error.InvalidInteger;
            var value = examples[3];
            value.hp = @intFromFloat(number);
            value.name = text;
            try serialize(monster.Monster, value, write_options);
        },
        else => return error.UnknownExample,
    }
    const table = try flatzz.Table.from(frame, .root);
    var output = std.Io.Writer.fixed(&report_buffer);
    try std.json.Stringify.value(@as(Report, .{
        .example = example,
        .capacity = output_buffer.len,
        .length = frame.len,
        .unused = @intFromPtr(frame.ptr) - @intFromPtr(&output_buffer),
        .table_start = table.layout.table_start,
        .table_size = table.layout.table_size,
        .vtable_start = table.layout.vtable_start,
        .vtable_size = table.layout.vtable_size,
        .fields = fields[0..field_count],
    }), .{}, &output);
    report = output.buffered();
}
