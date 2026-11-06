//! Build the site catalogue from Flatzz's official examples and native compiler.
const std = @import("std");
const files = @import("files.zig");

const Allocator = std.mem.Allocator;
const Dir = std.Io.Dir;
const Json = std.json.Value;

const Metadata = struct {
    root_table: ?struct { name: []const u8 } = null,
    fbs_files: []const struct { filename: []const u8 } = &.{},
};

const Schema = struct {
    key: []const u8,
    entry: []const u8,
    files: []const []const u8,
    title: []const u8,
    description: []const u8,
    // Omit the field without presets. With presets, use JSON null for unlisted schemas.
    runtime: ?Json,
};

const Program = struct {
    key: []const u8,
    title: []const u8,
    description: []const u8,
    files: []const []const u8,
    schemas: []const []const u8,
};

const Format = enum { json, zig, bfbs };

/// Stage a complete catalogue and publish it only after all compiler calls succeed.
/// Keep generated JSON, Zig, and BFBS bytes as written by the compiler.
pub fn generate(
    allocator: Allocator,
    io: std.Io,
    compiler: []const u8,
    official: []const u8,
    output: []const u8,
    presets: ?[]const u8,
) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const work = arena.allocator();
    var scratch = std.heap.ArenaAllocator.init(allocator);
    defer scratch.deinit();

    const cwd = Dir.cwd();
    const source = try cwd.realPathFileAlloc(io, official, work);
    const destination = try files.preparationOutput(work, io, source, output);
    const directory = try cwd.openDir(io, source, .{ .iterate = true, .follow_symlinks = false });
    defer directory.close(io);
    var discovered: std.ArrayList([]const u8) = .empty;
    try discover(work, io, directory, "", &discovered);

    const runtime: ?std.json.ObjectMap = if (presets) |path| runtime_blk: {
        const parsed = try std.json.parseFromSliceLeaky(
            Json,
            work,
            try files.read(work, io, path),
            .{ .parse_numbers = false },
        );
        if (parsed != .object) return error.InvalidCataloguePresets;
        break :runtime_blk parsed.object;
    } else null;
    const stage = try files.staging(work, io, destination);
    defer cwd.deleteTree(io, stage) catch {};
    const job: Generator = .{
        .allocator = work,
        .io = io,
        .compiler = compiler,
        .source = source,
        .stage = stage,
    };

    var sources: std.ArrayList([]const u8) = .empty;
    var known_schemas: std.StringHashMapUnmanaged(void) = .empty;
    for (discovered.items) |name| {
        if (!std.mem.endsWith(u8, name, ".fbs")) continue;
        try sources.append(work, name);
        try known_schemas.put(work, name, {});
        try job.copy(name, &.{ "sources", name });
    }
    var schemas: std.ArrayList(Schema) = .empty;
    for (sources.items) |entry| {
        defer _ = scratch.reset(.free_all);
        const schema = try job.schema(scratch.allocator(), entry, known_schemas, runtime);
        if (schema) |root| try schemas.append(work, root);
    }
    if (schemas.items.len == 0) return error.NoRootedExamples;

    var programs: std.ArrayList(Program) = .empty;
    for (discovered.items) |name| {
        if (!std.mem.eql(u8, std.fs.path.basenamePosix(name), "main.zig")) continue;
        defer _ = scratch.reset(.free_all);
        try programs.append(work, try job.program(
            scratch.allocator(),
            name,
            discovered.items,
            schemas.items,
        ));
    }
    for (discovered.items) |name| {
        if (std.mem.eql(u8, name, "README.md")) {
            try job.copy(name, &.{name});
            break;
        }
    }

    var json: std.Io.Writer.Allocating = .init(work);
    try std.json.Stringify.value(.{
        .sources = sources.items,
        .schemas = schemas.items,
        .programs = programs.items,
    }, .{ .whitespace = .indent_2, .emit_null_optional_fields = false }, &json.writer);
    try json.writer.writeByte('\n');
    try files.write(io, try std.fs.path.join(work, &.{ stage, "catalog.json" }), json.written());
    try files.publish(work, io, stage, destination);
}

const Generator = struct {
    allocator: Allocator,
    io: std.Io,
    compiler: []const u8,
    source: []const u8,
    stage: []const u8,

    fn schema(
        self: Generator,
        scratch: Allocator,
        entry: []const u8,
        known: std.StringHashMapUnmanaged(void),
        runtime: ?std.json.ObjectMap,
    ) !?Schema {
        const input = try std.fs.path.join(scratch, &.{ self.source, entry });
        const json = try self.convert(scratch, .json, input);
        const metadata = try std.json.parseFromSliceLeaky(
            Metadata,
            scratch,
            json,
            .{ .ignore_unknown_fields = true },
        );

        // Include-only schemas must also stay within the discovered source tree.
        const allocator = self.allocator;
        var includes: std.ArrayList([]const u8) = .empty;
        try includes.append(allocator, entry);
        for (metadata.fbs_files) |file| {
            const canonical = try Dir.cwd().realPathFileAlloc(self.io, file.filename, scratch);
            if (!std.mem.eql(u8, canonical, file.filename))
                return error.SchemaIncludeOutsideExamples;
            const relative = relativeTo(self.source, canonical) orelse
                return error.SchemaIncludeOutsideExamples;
            const name = known.getKey(relative) orelse return error.SchemaIncludeOutsideExamples;
            if (std.mem.eql(u8, name, entry)) continue;
            try includes.append(allocator, name);
        }
        const root = metadata.root_table orelse return null;
        std.mem.sort([]const u8, includes.items[1..], {}, pathLessThan);
        var unique: usize = 1;
        for (includes.items[1..]) |name| {
            if (unique > 1 and std.mem.eql(u8, includes.items[unique - 1], name)) continue;
            includes.items[unique] = name;
            unique += 1;
        }
        includes.shrinkRetainingCapacity(unique);

        const key = entry[0 .. entry.len - ".fbs".len];
        for ([_]Format{ .json, .zig, .bfbs }) |format| {
            const bytes = if (format == .json) json else try self.convert(scratch, format, input);
            const filename = try std.fmt.allocPrint(
                scratch,
                "{s}/generated/{s}.{s}",
                .{ self.stage, key, @tagName(format) },
            );
            try files.write(self.io, filename, bytes);
        }
        const title_start = if (std.mem.lastIndexOfScalar(u8, root.name, '.')) |index|
            index + 1
        else
            0;
        const suffix = if (includes.items.len == 1) "" else try std.fmt.allocPrint(
            scratch,
            " · {d} linked files",
            .{includes.items.len},
        );
        return .{
            .key = key,
            .entry = entry,
            .files = try includes.toOwnedSlice(allocator),
            .title = try allocator.dupe(u8, root.name[title_start..]),
            .description = try std.fmt.allocPrint(
                allocator,
                "Official schema: {s}{s}.",
                .{ entry, suffix },
            ),
            .runtime = if (runtime) |presets| presets.get(entry) orelse .null else null,
        };
    }

    fn convert(
        self: Generator,
        scratch: Allocator,
        format: Format,
        input: []const u8,
    ) ![]const u8 {
        const flag = switch (format) {
            .json => "--json",
            .zig => "--zig",
            .bfbs => "--bfbs",
        };
        const limit: std.Io.Limit = .limited(32 * 1024 * 1024);
        const timeout: std.Io.Timeout = .{
            .duration = .{ .raw = .fromSeconds(60), .clock = .awake },
        };
        const result = std.process.run(scratch, self.io, .{
            .argv = &.{ self.compiler, flag, input },
            .stdout_limit = limit,
            .stderr_limit = limit,
            .timeout = timeout.toDeadline(self.io),
        }) catch |failure| {
            std.log.err("{s} {s}: {s}", .{ flag, input, @errorName(failure) });
            return failure;
        };
        if (!result.term.success()) {
            std.log.err("{s} {s}: {s}", .{ flag, input, result.stderr });
            return error.CatalogueCompilerFailed;
        }
        return result.stdout;
    }

    fn program(
        self: Generator,
        scratch: Allocator,
        main: []const u8,
        discovered: []const []const u8,
        schemas: []const Schema,
    ) !Program {
        const allocator = self.allocator;
        const key = std.fs.path.dirnamePosix(main) orelse "";
        var names: std.ArrayList([]const u8) = .empty;
        var references: std.Io.Writer.Allocating = .init(scratch);
        var description: []const u8 = "";
        for (discovered) |name| {
            const relative = relativeTo(key, name) orelse continue;
            try names.append(allocator, relative);
            try self.copy(name, &.{ "programs", name });
            if (std.mem.endsWith(u8, name, ".zig") or std.mem.endsWith(u8, name, ".zon")) {
                const path = try std.fs.path.join(scratch, &.{ self.source, name });
                const source = try files.read(scratch, self.io, path);
                try references.writer.writeAll(source);
                try references.writer.writeByte('\n');
                if (std.mem.eql(u8, name, main)) {
                    description = try docDescription(allocator, source);
                }
            }
        }
        var related: std.ArrayList([]const u8) = .empty;
        for (schemas) |schema_entry| {
            const path = try std.fmt.allocPrint(scratch, "example/{s}", .{schema_entry.entry});
            const literal = try std.json.Stringify.valueAlloc(scratch, path, .{});
            if (std.mem.eql(u8, std.fs.path.dirnamePosix(schema_entry.entry) orelse "", key) or
                std.mem.indexOf(u8, references.written(), literal) != null)
            {
                try related.append(allocator, schema_entry.key);
            }
        }
        const title = try programTitle(allocator, if (key.len == 0) "examples" else key);
        return .{
            .key = key,
            .title = title,
            .description = if (description.len != 0) description else try std.fmt.allocPrint(
                allocator,
                "Official example: {s}.",
                .{if (key.len == 0) "example" else key},
            ),
            .files = try names.toOwnedSlice(allocator),
            .schemas = try related.toOwnedSlice(allocator),
        };
    }

    fn copy(self: Generator, source: []const u8, destination: []const []const u8) !void {
        const input = try std.fs.path.join(self.allocator, &.{ self.source, source });
        const relative = try std.fs.path.join(self.allocator, destination);
        const output = try std.fs.path.join(self.allocator, &.{ self.stage, relative });
        try Dir.copyFileAbsolute(input, output, self.io, .{ .make_path = true });
    }
};

fn discover(
    allocator: Allocator,
    io: std.Io,
    directory: Dir,
    prefix: []const u8,
    result: *std.ArrayList([]const u8),
) !void {
    var entries: std.ArrayList(Dir.Entry) = .empty;
    var iterator = directory.iterate();
    while (try iterator.next(io)) |entry| {
        if (entry.name[0] == '.' or std.mem.eql(u8, entry.name, "zig-out") or
            std.mem.eql(u8, entry.name, "node_modules")) continue;
        if (entry.kind != .directory and entry.kind != .file) continue;
        var saved = entry;
        saved.name = try allocator.dupe(u8, entry.name);
        try entries.append(allocator, saved);
    }
    std.mem.sort(Dir.Entry, entries.items, {}, struct {
        fn lessThan(_: void, left: Dir.Entry, right: Dir.Entry) bool {
            return pathLessThan({}, left.name, right.name);
        }
    }.lessThan);
    for (entries.items) |entry| {
        const name = if (prefix.len == 0) entry.name else try std.fmt.allocPrint(
            allocator,
            "{s}/{s}",
            .{ prefix, entry.name },
        );
        switch (entry.kind) {
            .file => try result.append(allocator, name),
            .directory => {
                const child = try directory.openDir(io, entry.name, .{
                    .iterate = true,
                    .follow_symlinks = false,
                });
                defer child.close(io);
                try discover(allocator, io, child, name, result);
            },
            else => unreachable,
        }
    }
}

fn pathLessThan(_: void, left: []const u8, right: []const u8) bool {
    return std.mem.lessThan(u8, left, right);
}

fn relativeTo(parent: []const u8, child: []const u8) ?[]const u8 {
    if (parent.len == 0) return child;
    if (child.len <= parent.len or !std.mem.startsWith(u8, child, parent)) return null;
    if (std.fs.path.isSep(parent[parent.len - 1])) return child[parent.len..];
    if (!std.fs.path.isSep(child[parent.len])) return null;
    return child[parent.len + 1 ..];
}

fn programTitle(allocator: Allocator, path: []const u8) ![]const u8 {
    var title: std.Io.Writer.Allocating = .init(allocator);
    var words = std.mem.tokenizeAny(u8, std.fs.path.basenamePosix(path), "_-");
    while (words.next()) |word| {
        if (title.written().len != 0) try title.writer.writeByte(' ');
        if (std.mem.eql(u8, word, "readme")) {
            try title.writer.writeAll("README");
        } else {
            try title.writer.writeByte(std.ascii.toUpper(word[0]));
            try title.writer.writeAll(word[1..]);
        }
    }
    return title.toOwnedSlice();
}

fn docDescription(allocator: Allocator, source: []const u8) ![]const u8 {
    var description: std.Io.Writer.Allocating = .init(allocator);
    var lines = std.mem.splitScalar(u8, source, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (!std.mem.startsWith(u8, trimmed, "//!")) break;
        const comment = std.mem.trim(u8, trimmed["//!".len..], " \t");
        if (comment.len == 0) break;
        if (description.written().len != 0) try description.writer.writeByte(' ');
        try description.writer.writeAll(comment);
    }
    return description.toOwnedSlice();
}
