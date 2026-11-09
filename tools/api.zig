//! Adapt Zig's pinned documentation viewer for the two themed Zine references.
const std = @import("std");
const files = @import("files.zig");

const asset_limit: std.Io.Limit = .limited(64 * 1024 * 1024);

fn between(source: []const u8, opening: []const u8, closing: []const u8) ![]const u8 {
    if (std.mem.count(u8, source, opening) != 1 or std.mem.count(u8, source, closing) != 1)
        return error.UnsupportedViewerLayout;
    const start = std.mem.indexOf(u8, source, opening).? + opening.len;
    const end = std.mem.indexOfPos(u8, source, start, closing) orelse
        return error.UnsupportedViewerLayout;
    return source[start..end];
}

fn replaceOnce(
    allocator: std.mem.Allocator,
    source: []const u8,
    original: []const u8,
    replacement: []const u8,
) ![]u8 {
    if (std.mem.count(u8, source, original) != 1) return error.UnsupportedViewerTransport;
    return files.replace(allocator, source, original, replacement);
}

fn viewerBody(allocator: std.mem.Allocator, html: []const u8) ![]const u8 {
    const body = try between(html, "<body>", "</body>");
    const navigation = try between(body, "<nav>", "</nav>");
    const element = try std.fmt.allocPrint(allocator, "<nav>{s}</nav>", .{navigation});
    const viewer = try replaceOnce(allocator, body, element, "");
    const identifiers = [_][]const u8{
        "search", "status", "hdrName", "tldDocs", "sourceText", "docTestsCode",
    };
    for (identifiers) |identifier| {
        const attribute = try std.fmt.allocPrint(allocator, "id=\"{s}\"", .{identifier});
        if (std.mem.indexOf(u8, viewer, attribute) == null) return error.IncompleteViewer;
    }
    return std.mem.trim(u8, viewer, &std.ascii.whitespace);
}

fn viewerHead(allocator: std.mem.Allocator, html: []const u8) ![]const u8 {
    var head: std.Io.Writer.Allocating = .init(allocator);
    var remaining = html;
    var count: usize = 0;
    const preload = "<link rel=\"preload\"";
    while (std.mem.indexOf(u8, remaining, preload)) |start| {
        const end = std.mem.indexOfScalarPos(u8, remaining, start + preload.len, '>') orelse
            return error.UnsupportedViewerLayout;
        if (end == start + preload.len) return error.UnsupportedViewerLayout;
        if (count != 0) try head.writer.writeByte('\n');
        try head.writer.writeAll(remaining[start .. end + 1]);
        remaining = remaining[end + 1 ..];
        count += 1;
    }
    if (count != 2) return error.UnsupportedViewerLayout;
    const archived = try replaceOnce(
        allocator,
        head.written(),
        "href=\"sources.tar\"",
        "href=\"sources.tar.gz\"",
    );
    return replaceOnce(
        allocator,
        archived,
        "type=\"application/x-tar\"",
        "type=\"application/gzip\"",
    );
}

fn viewerScript(allocator: std.mem.Allocator, script: []const u8) ![]const u8 {
    const archived = try replaceOnce(
        allocator,
        script,
        "fetch(\"sources.tar\")",
        "fetch(\"sources.tar.gz\")",
    );
    return replaceOnce(
        allocator,
        archived,
        "return response.arrayBuffer();",
        "return new Response(response.body.pipeThrough(new DecompressionStream(\"gzip\")))" ++
            ".arrayBuffer();",
    );
}

/// Check binary framing here. The browser-facing tests instantiate the complete module.
fn validateWasm(wasm: []const u8) error{InvalidViewerWasm}!void {
    const header = std.wasm.magic ++ std.wasm.version;
    if (!std.mem.startsWith(u8, wasm, &header)) return error.InvalidViewerWasm;
    var sections: std.Io.Reader = .fixed(wasm[header.len..]);
    while (sections.seek < sections.end) {
        _ = sections.takeByte() catch return error.InvalidViewerWasm;
        const length_start = sections.seek;
        const length = sections.takeLeb128(u32) catch return error.InvalidViewerWasm;
        if (sections.seek - length_start > 5) return error.InvalidViewerWasm;
        sections.discardAll(length) catch return error.InvalidViewerWasm;
    }
}

fn prepareViewer(
    allocator: std.mem.Allocator,
    io: std.Io,
    input: []const u8,
    output: []const u8,
) !void {
    const source = try std.Io.Dir.cwd().openDir(io, input, .{});
    defer source.close(io);
    const html = try source.readFileAlloc(io, "index.html", allocator, asset_limit);
    const body = try viewerBody(allocator, html);
    const head = try viewerHead(allocator, html);
    const script = try source.readFileAlloc(io, "main.js", allocator, asset_limit);
    const loader = try viewerScript(allocator, script);
    const wasm = try source.readFileAlloc(io, "main.wasm", allocator, asset_limit);
    try validateWasm(wasm);
    const archive = try source.readFileAlloc(io, "sources.tar", allocator, asset_limit);
    if (archive.len == 0) return error.MissingSourceArchive;

    var compressed: std.Io.Writer.Allocating = .init(allocator);
    try compressed.ensureUnusedCapacity(16);
    const window = try allocator.alloc(u8, std.compress.flate.max_window_len);
    var compressor = try std.compress.flate.Compress.init(
        &compressed.writer,
        window,
        .gzip,
        .best,
    );
    try compressor.writer.writeAll(archive);
    try compressor.finish();

    try std.Io.Dir.cwd().createDir(io, output, .default_dir);
    const destination = try std.Io.Dir.cwd().openDir(io, output, .{});
    defer destination.close(io);
    const assets = [_][]const u8{
        "head.html", "body.html", "main.js", "main.wasm", "sources.tar.gz",
    };
    for (assets, [_][]const u8{ head, body, loader, wasm, compressed.written() }) |name, bytes|
        try destination.writeFile(io, .{ .sub_path = name, .data = bytes });
}

/// Prepare both viewers in a sibling directory and replace the owned output on success.
pub fn prepare(
    allocator: std.mem.Allocator,
    io: std.Io,
    input: []const u8,
    output: []const u8,
) !void {
    const directory = std.Io.Dir.cwd();
    const input_path = try directory.realPathFileAlloc(io, input, allocator);
    defer allocator.free(input_path);
    const output_path = try files.preparationOutput(allocator, io, input_path, output);
    defer allocator.free(output_path);

    const staged = try files.staging(allocator, io, output_path);
    defer allocator.free(staged);
    defer directory.deleteTree(io, staged) catch {};

    const viewers = [_]struct { name: []const u8, relative: []const u8 }{
        .{ .name = "runtime", .relative = "" },
        .{ .name = "compiler", .relative = "compiler" },
    };
    for (viewers) |viewer| {
        var scratch = std.heap.ArenaAllocator.init(allocator);
        defer scratch.deinit();
        const temporary = scratch.allocator();
        const source = try std.fs.path.join(temporary, &.{ input_path, viewer.relative });
        const destination = try std.fs.path.join(temporary, &.{ staged, viewer.name });
        try prepareViewer(temporary, io, source, destination);
    }
    try files.publish(allocator, io, staged, output_path);
}
