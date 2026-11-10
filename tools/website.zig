//! Run Zine with generated library assets and validate output before replacing dist.
//! Paths are borrowed; temporary command arguments and indexes use a caller arena.
const std = @import("std");
const files = @import("files.zig");

pub const Options = struct {
    zine_executable: []const u8,
    bundle_directory: []const u8,
    site_directory: []const u8 = ".",
    output_directory: []const u8 = "dist",
    port: u16 = 1991,
    engine_stderr: std.process.SpawnOptions.StdIo = .inherit,
};

pub const Result = struct { pages: usize = 0, references: usize = 0 };

pub const Attributes = struct {
    source: []const u8,
    needle: []const u8,
    offset: usize = 0,

    pub fn next(self: *Attributes) ?[]const u8 {
        while (std.mem.indexOfPos(u8, self.source, self.offset, self.needle)) |start| {
            self.offset = start + self.needle.len;
            if (start != 0 and (std.ascii.isAlphanumeric(self.source[start - 1]) or
                self.source[start - 1] == '_')) continue;
            const end = std.mem.indexOfScalarPos(u8, self.source, self.offset, '"') orelse
                return null;
            const value = self.source[self.offset..end];
            self.offset = end + 1;
            return value;
        }
        return null;
    }
};

pub fn attributes(source: []const u8, comptime name: []const u8) Attributes {
    return .{ .source = source, .needle = name ++ "=\"" };
}

/// Decode strict percent escapes before resolving filesystem paths.
pub fn decode(allocator: std.mem.Allocator, encoded: []const u8) ![]const u8 {
    var position: usize = 0;
    while (position < encoded.len) : (position += 1) if (encoded[position] == '%') {
        if (encoded.len - position < 3) return error.InvalidUrl;
        _ = std.fmt.parseInt(u8, encoded[position + 1 ..][0..2], 16) catch
            return error.InvalidUrl;
        position += 2;
    };
    const decoded = std.Uri.percentDecodeInPlace(try allocator.dupe(u8, encoded));
    if (std.mem.indexOfAny(u8, decoded, "\x00\\") != null or
        !std.unicode.utf8ValidateSlice(decoded)) return error.InvalidUrl;
    return decoded;
}

/// Return a normalized relative path, rejecting traversal above its root.
pub fn localPath(allocator: std.mem.Allocator, path: []const u8) ![]const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    var segments = std.mem.tokenizeScalar(u8, path, '/');
    while (segments.next()) |segment| {
        if (std.mem.eql(u8, segment, ".")) continue;
        if (std.mem.eql(u8, segment, "..")) {
            _ = parts.pop() orelse return error.PathEscapesRoot;
        } else try parts.append(allocator, segment);
    }
    return std.mem.join(allocator, "/", parts.items);
}

/// Remove the exact deployment prefix before local reference lookup.
pub fn sitePath(allocator: std.mem.Allocator, path: []const u8, prefix: []const u8) ![]const u8 {
    const normalized = try localPath(allocator, try decode(allocator, path));
    if (prefix.len == 0) return normalized;
    if (std.mem.eql(u8, normalized, prefix)) return "";
    if (!std.mem.startsWith(u8, normalized, prefix) or normalized[prefix.len] != '/')
        return error.MissingLocalReference;
    return normalized[prefix.len + 1 ..];
}

fn apiPage(path: []const u8) bool {
    return std.mem.eql(u8, path, "docs/api/runtime/index.html") or
        std.mem.eql(u8, path, "docs/api/compiler/index.html");
}

/// Check page structure, local URLs, and fragments. API fragments belong to Zig's viewer.
pub fn validate(allocator: std.mem.Allocator, io: std.Io, directory: []const u8) !Result {
    const Page = struct {
        html: []const u8,
        identifiers: std.StringHashMapUnmanaged(void) = .empty,
    };
    var pages: std.StringArrayHashMapUnmanaged(Page) = .empty;
    for (try files.list(allocator, io, directory)) |relative| {
        if (!std.mem.endsWith(u8, relative, ".html")) continue;
        const path = try std.fs.path.join(allocator, &.{ directory, relative });
        var page: Page = .{ .html = try files.read(allocator, io, path) };
        var identifiers = attributes(page.html, "id");
        while (identifiers.next()) |identifier| {
            if ((try page.identifiers.getOrPut(allocator, identifier)).found_existing)
                return error.DuplicateHtmlId;
        }
        if (!apiPage(relative)) {
            var offset: usize = 0;
            var headings: usize = 0;
            while (std.mem.indexOfPos(u8, page.html, offset, "<h1")) |start| {
                offset = start + 3;
                if (offset < page.html.len and
                    (page.html[offset] == '>' or std.ascii.isWhitespace(page.html[offset])))
                    headings += 1;
            }
            if (headings != 1) return error.InvalidHeadingCount;
        }
        try pages.put(allocator, relative, page);
    }
    const homepage = pages.get("index.html") orelse return error.MissingHomePage;
    // The build-asset URL includes Zine's release prefix and its preview override.
    var runtime_urls = attributes(homepage.html, "data-runtime");
    const runtime_url = runtime_urls.next() orelse "/assets/runtime.wasm";
    const suffix = "assets/runtime.wasm";
    if (!std.mem.startsWith(u8, runtime_url, "/") or
        std.mem.startsWith(u8, runtime_url, "//") or
        !std.mem.endsWith(u8, runtime_url, "/" ++ suffix)) return error.InvalidSiteRoot;
    const site_root = runtime_url[0 .. runtime_url.len - suffix.len];
    const prefix = try localPath(allocator, try decode(allocator, site_root));
    var result: Result = .{ .pages = pages.count() };
    for (pages.keys(), pages.values()) |relative, page| {
        const base = try std.Uri.parse(try std.fmt.allocPrint(
            allocator,
            "https://site.invalid{s}{s}",
            .{ site_root, relative },
        ));
        inline for (.{ "href", "src" }) |attribute| {
            var references = attributes(page.html, attribute);
            while (references.next()) |reference| {
                const unescaped = try files.replace(allocator, reference, "&amp;", "&");
                var buffer = try allocator.alloc(
                    u8,
                    unescaped.len * 2 + relative.len + site_root.len + 256,
                );
                @memcpy(buffer[0..unescaped.len], unescaped);
                const uri = try std.Uri.resolveInPlace(base, unescaped.len, &buffer);
                if (!std.ascii.eqlIgnoreCase(uri.scheme, "https") or uri.host == null or
                    !std.ascii.eqlIgnoreCase(
                        try uri.host.?.toRawMaybeAlloc(allocator),
                        "site.invalid",
                    ) or (uri.port != null and uri.port.? != 443)) continue;
                var target = try sitePath(allocator, uri.path.percent_encoded, prefix);
                var target_path = try std.fs.path.join(allocator, &.{ directory, target });
                const stat = std.Io.Dir.cwd().statFile(io, target_path, .{}) catch
                    return error.MissingLocalReference;
                if (stat.kind == .directory) {
                    target = try std.fs.path.join(allocator, &.{ target, "index.html" });
                    target_path = try std.fs.path.join(allocator, &.{ directory, target });
                }
                if (!try files.exists(io, target_path)) return error.MissingLocalReference;
                if (uri.fragment) |fragment| {
                    if (!fragment.isEmpty() and !apiPage(target)) {
                        const destination = pages.get(target) orelse return error.MissingFragment;
                        if (!destination.identifiers.contains(
                            try decode(allocator, fragment.percent_encoded),
                        )) return error.MissingFragment;
                    }
                }
                result.references += 1;
            }
        }
    }
    return result;
}

fn partial(path: []const u8) bool {
    return std.mem.startsWith(u8, path, "_partials/");
}

/// Reserve authored pages and generated destinations before Zine writes any output.
pub fn preflight(allocator: std.mem.Allocator, io: std.Io, options: Options) !void {
    var destinations: std.StringHashMapUnmanaged(void) = .empty;
    for (try files.list(allocator, io, options.bundle_directory)) |relative| {
        if (!partial(relative)) try destinations.put(allocator, relative, {});
    }
    const asset_directory = try std.fs.path.join(allocator, &.{ options.site_directory, "assets" });
    for (try files.list(allocator, io, asset_directory)) |relative| {
        const destination = try std.fs.path.join(allocator, &.{ "assets", relative });
        if ((try destinations.getOrPut(allocator, destination)).found_existing)
            return error.GeneratedAssetCollision;
    }
    var pages: std.StringHashMapUnmanaged(void) = .empty;
    const content_directory = try std.fs.path.join(allocator, &.{
        options.site_directory, "content",
    });
    for (try files.list(allocator, io, content_directory)) |relative| {
        if (!std.mem.endsWith(u8, relative, ".smd")) {
            if ((try destinations.getOrPut(allocator, relative)).found_existing)
                return error.AssetCollision;
            continue;
        }
        var stem = relative[0 .. relative.len - 4];
        if (std.mem.eql(u8, stem, "index")) {
            stem = "";
        } else if (std.mem.endsWith(u8, stem, "/index")) stem = stem[0 .. stem.len - 6];
        const destination = try std.fs.path.join(allocator, &.{ stem, "index.html" });
        if ((try pages.getOrPut(allocator, destination)).found_existing)
            return error.DuplicatePageRoute;
        if ((try destinations.getOrPut(allocator, destination)).found_existing)
            return error.PageAssetCollision;
    }
    const layouts = try std.fs.path.join(allocator, &.{ options.site_directory, "layouts" });
    _ = try files.list(allocator, io, layouts);
}

/// Release and preview share exact file bindings. Partials are template inputs only.
/// Zine's live server requires input paths relative to its project working directory.
pub fn arguments(
    allocator: std.mem.Allocator,
    io: std.Io,
    options: Options,
    output: ?[]const u8,
) ![]const []const u8 {
    const base = try std.Io.Dir.cwd().realPathFileAlloc(io, options.site_directory, allocator);
    var command: std.ArrayList([]const u8) = .empty;
    try command.append(allocator, try std.Io.Dir.cwd().realPathFileAlloc(
        io,
        options.zine_executable,
        allocator,
    ));
    if (output) |directory| {
        try command.appendSlice(allocator, &.{
            "release", try std.fmt.allocPrint(allocator, "--output={s}", .{directory}),
        });
    } else try command.appendSlice(allocator, &.{
        "--host=127.0.0.1",
        try std.fmt.allocPrint(allocator, "--port={d}", .{options.port}),
        "--url-path-prefix=",
    });
    try appendAssets(allocator, io, &command, base, options.bundle_directory, "");
    try appendAssets(
        allocator,
        io,
        &command,
        base,
        try std.fs.path.join(allocator, &.{ base, "assets" }),
        "assets",
    );
    return command.toOwnedSlice(allocator);
}

fn appendAssets(
    allocator: std.mem.Allocator,
    io: std.Io,
    command: *std.ArrayList([]const u8),
    base: []const u8,
    directory: []const u8,
    prefix: []const u8,
) !void {
    const root = try std.Io.Dir.cwd().realPathFileAlloc(io, directory, allocator);
    for (try files.list(allocator, io, directory)) |relative| {
        const absolute = try std.fs.path.join(allocator, &.{ root, relative });
        const name = if (prefix.len == 0) relative else try std.fmt.allocPrint(
            allocator,
            "{s}/{s}",
            .{ prefix, relative },
        );
        try command.appendSlice(allocator, &.{
            try std.fmt.allocPrint(allocator, "--build-asset={s}", .{name}),
            try std.fs.path.relativeAlloc(allocator, base, null, base, absolute),
        });
        if (!partial(name)) try command.append(
            allocator,
            try std.fmt.allocPrint(allocator, "--install-always={s}", .{name}),
        );
    }
}

fn protectedOutput(
    allocator: std.mem.Allocator,
    source: []const u8,
    bundle: []const u8,
    destination: []const u8,
) !bool {
    const default_output = try std.fs.path.join(allocator, &.{ source, "dist" });
    return files.containsPath(destination, source) or files.containsPath(destination, bundle) or
        files.containsPath(bundle, destination) or
        (files.containsPath(source, destination) and !std.mem.eql(u8, destination, default_output));
}

/// Validate a fresh staging directory before replacing the previous complete output.
/// Failed generation, validation, or installation preserves the last successful site.
/// Within the source checkout only dist may be replaced; custom output must be external.
pub fn build(allocator: std.mem.Allocator, io: std.Io, options: Options) !Result {
    try preflight(allocator, io, options);
    const source = try std.Io.Dir.cwd().realPathFileAlloc(io, options.site_directory, allocator);
    const bundle = try std.Io.Dir.cwd().realPathFileAlloc(io, options.bundle_directory, allocator);
    const requested = try std.fs.path.resolveAlloc(allocator, &.{
        source, options.output_directory,
    });
    if (try protectedOutput(allocator, source, bundle, requested))
        return error.OutputOverlapsSource;
    const parent = std.fs.path.dirname(requested).?;
    const physical_parent = std.Io.Dir.cwd().realPathFileAlloc(
        io,
        parent,
        allocator,
    ) catch |failure|
        switch (failure) {
            error.FileNotFound => parent_blk: {
                try std.Io.Dir.cwd().createDirPath(io, parent);
                break :parent_blk try std.Io.Dir.cwd().realPathFileAlloc(io, parent, allocator);
            },
            else => return failure,
        };
    // Resolve parent aliases before protecting sources. Do not follow the final
    // component: replacing a dist symlink must leave its target untouched.
    const destination = try std.fs.path.join(allocator, &.{
        physical_parent, std.fs.path.basename(requested),
    });
    if (try protectedOutput(allocator, source, bundle, destination))
        return error.OutputOverlapsSource;
    const staging = try files.staging(allocator, io, destination);
    defer std.Io.Dir.cwd().deleteTree(io, staging) catch {};
    var child = try std.process.spawn(io, .{
        .argv = try arguments(allocator, io, options, staging),
        .cwd = .{ .path = options.site_directory },
        .stderr = options.engine_stderr,
    });
    defer child.kill(io);
    if (!(try child.wait(io)).success()) return error.ZineFailed;
    const result = try validate(allocator, io, staging);
    try files.publish(allocator, io, staging, destination);
    return result;
}

/// Replace the coordinator so Ctrl+C reaches Zine's live server directly.
/// Content, layouts, and static assets reload; compiled artifacts need rebuilding.
pub fn serve(allocator: std.mem.Allocator, io: std.Io, options: Options) !void {
    try preflight(allocator, io, options);
    return std.process.replace(io, .{
        .argv = try arguments(allocator, io, options, null),
        .cwd = .{ .path = options.site_directory },
    });
}
