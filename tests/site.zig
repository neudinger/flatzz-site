//! Native release, URL, collision, and live-preview contracts for the Zine adapter.
const std = @import("std");
const site = @import("site");
const paths = @import("paths");

const Fixture = struct {
    temporary: std.testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    options: site.website.Options,

    fn init() !Fixture {
        var temporary = std.testing.tmpDir(.{ .iterate = true });
        errdefer temporary.cleanup();
        var fixture: Fixture = .{
            .temporary = temporary,
            .arena = std.heap.ArenaAllocator.init(std.testing.allocator),
            .options = .{ .zine_executable = "", .bundle_directory = "" },
        };
        errdefer fixture.arena.deinit();
        const allocator = fixture.arena.allocator();
        const root = try temporary.dir.realPathFileAlloc(std.testing.io, ".", allocator);
        fixture.options = .{
            .zine_executable = try std.Io.Dir.cwd().realPathFileAlloc(
                std.testing.io,
                paths.zine_executable,
                allocator,
            ),
            .bundle_directory = try std.fs.path.join(allocator, &.{ root, "bundle" }),
            .site_directory = root,
            .output_directory = "dist",
            .engine_stderr = .ignore,
        };
        try fixture.write("assets/site.css", "body { color: coral; }\n");
        try fixture.write("bundle/assets/runtime.wasm", "\x00asm\x01\x00\x00\x00");
        try fixture.write("bundle/_partials/viewer.html", "<p>Template input only.</p>\n");
        try fixture.write("zine.ziggy",
            \\.zine_version = "0.14.1-dev",
            \\.supermd = .{ .headings_h2 = true },
            \\.site = .simple(.{
            \\    .title = "Fixture",
            \\    .host_url = "https://example.test",
            \\    .url_path_prefix = "flatzz-site",
            \\    .content_dir_path = "content",
            \\    .layouts_dir_path = "layouts",
            \\    .assets_dir_path = "assets",
            \\    .static_assets = [],
            \\}),
            \\
        );
        try fixture.write("layouts/content.shtml",
            \\<!doctype html>
            \\<html lang="en"><head><title :text="$page.title"></title>
            \\<link rel="stylesheet" href="$build.asset('assets/site.css').link()"></head>
            \\<body data-runtime="$build.asset('assets/runtime.wasm').link()">
            \\<h1 :text="$page.title"></h1><main id="content" :html="$page.content()"></main>
            \\</body></html>
            \\
        );
        try fixture.write("content/index.smd",
            \\---
            \\.title = "Fixture home",
            \\.date = .date("2026-11-10T00:00:00"),
            \\.layout = "content.shtml",
            \\---
            \\# Overview
            \\```=html
            \\<p id="overview">Read the <a href="docs/">documentation</a>.</p>
            \\```
            \\
        );
        try fixture.write("content/docs/index.smd",
            \\---
            \\.title = "Fixture documentation",
            \\.date = .date("2026-11-10T00:00:00"),
            \\.layout = "content.shtml",
            \\---
            \\# Details
            \\```=html
            \\<a href="../#overview">Home</a>
            \\```
            \\
        );
        return fixture;
    }

    fn deinit(self: *Fixture) void {
        self.temporary.cleanup();
        self.arena.deinit();
    }

    fn path(self: *Fixture, relative: []const u8) ![]const u8 {
        return std.fs.path.join(self.arena.allocator(), &.{
            self.options.site_directory, relative,
        });
    }

    fn write(self: *Fixture, relative: []const u8, contents: []const u8) !void {
        try site.files.write(std.testing.io, try self.path(relative), contents);
    }

    fn read(self: *Fixture, relative: []const u8) ![]const u8 {
        return site.files.read(self.arena.allocator(), std.testing.io, try self.path(relative));
    }

    fn build(self: *Fixture) !site.website.Result {
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        return site.website.build(arena.allocator(), std.testing.io, self.options);
    }

    fn expectFailure(self: *Fixture, expected: anyerror) !void {
        try std.testing.expectError(expected, self.build());
        try std.testing.expectEqualStrings("Previous valid site", try self.read("dist/keep"));
        var entries = self.temporary.dir.iterate();
        while (try entries.next(std.testing.io)) |entry|
            try std.testing.expect(!std.mem.startsWith(u8, entry.name, ".zine-build-"));
    }
};

fn contains(source: []const u8, expected: []const u8) !void {
    if (std.mem.indexOf(u8, source, expected) == null) {
        std.debug.print("Missing text: {s}\n", .{expected});
        return error.TestExpectedEqual;
    }
}

test "clean preserves authored files caches and output symlink targets" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    try fixture.write("dist/obsolete", "Generated");
    try fixture.write(".zig-cache/keep", "Cached");
    try site.clean(std.testing.io, fixture.temporary.dir);
    try site.clean(std.testing.io, fixture.temporary.dir);
    try std.testing.expect(!try site.files.exists(std.testing.io, try fixture.path("dist")));
    try std.testing.expectEqualStrings("Cached", try fixture.read(".zig-cache/keep"));
    try std.testing.expectEqualStrings(
        "body { color: coral; }\n",
        try fixture.read("assets/site.css"),
    );
    try fixture.temporary.dir.symLink(std.testing.io, "assets", "dist", .{ .is_directory = true });
    try site.clean(std.testing.io, fixture.temporary.dir);
    try std.testing.expect(!try site.files.exists(std.testing.io, try fixture.path("dist")));
    try std.testing.expectEqualStrings(
        "body { color: coral; }\n",
        try fixture.read("assets/site.css"),
    );
}

test "URL validation preserves exact prefixes and rejects ambiguous or escaping paths" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    for ([_][]const u8{ "/%", "/%xx", "/%00", "/%ff", "/%5c.." }) |url|
        try std.testing.expectError(error.InvalidUrl, site.website.decode(allocator, url));
    for ([_][]const u8{ "/../outside", "/docs/../../outside" }) |url|
        try std.testing.expectError(error.PathEscapesRoot, site.website.localPath(allocator, url));
    for ([_]struct { url: []const u8, prefix: []const u8, expected: []const u8 }{
        .{ .url = "/flatzz-site/", .prefix = "flatzz-site", .expected = "" },
        .{ .url = "/flatzz-site/docs/", .prefix = "flatzz-site", .expected = "docs" },
        .{
            .url = "/%66latzz-site/docs/../assets/a.js",
            .prefix = "flatzz-site",
            .expected = "assets/a.js",
        },
        .{ .url = "/docs/api/runtime/", .prefix = "", .expected = "docs/api/runtime" },
    }) |route| try std.testing.expectEqualStrings(
        route.expected,
        try site.website.sitePath(allocator, route.url, route.prefix),
    );
    for ([_][]const u8{
        "/flatzz-siteevil/docs/", "/docs/", "/flatzz-site/%2e%2e/outside",
    }) |url| try std.testing.expectError(
        error.MissingLocalReference,
        site.website.sitePath(allocator, url, "flatzz-site"),
    );
}

test "release and preview bind identical assets with template-only partials" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    const allocator = fixture.arena.allocator();
    const release = try site.website.arguments(
        allocator,
        std.testing.io,
        fixture.options,
        "/output",
    );
    const preview = try site.website.arguments(allocator, std.testing.io, fixture.options, null);
    try std.testing.expectEqualStrings("release", release[1]);
    try std.testing.expectEqualStrings("--output=/output", release[2]);
    try std.testing.expectEqualStrings("--host=127.0.0.1", preview[1]);
    try std.testing.expectEqualStrings("--port=1991", preview[2]);
    try std.testing.expectEqualStrings("--url-path-prefix=", preview[3]);
    try std.testing.expectEqual(release.len - 3, preview.len - 4);
    for (release[3..], preview[4..]) |left, right|
        try std.testing.expectEqualStrings(left, right);
    const joined = try std.mem.join(allocator, "\n", release);
    try contains(joined, "--build-asset=_partials/viewer.html\nbundle/_partials/viewer.html\n");
    try contains(joined, "--install-always=assets/runtime.wasm");
    try std.testing.expect(std.mem.indexOf(u8, joined, "--install-always=_partials") == null);
}

test "preflight rejects routes and assets colliding with generated output" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    const allocator = fixture.arena.allocator();
    try fixture.write("content/docs.smd", try fixture.read("content/docs/index.smd"));
    try std.testing.expectError(
        error.DuplicatePageRoute,
        site.website.preflight(allocator, std.testing.io, fixture.options),
    );
    try fixture.temporary.dir.deleteFile(std.testing.io, "content/docs.smd");
    try fixture.write("assets/runtime.wasm", "Collision");
    try std.testing.expectError(
        error.GeneratedAssetCollision,
        site.website.preflight(allocator, std.testing.io, fixture.options),
    );
    try fixture.temporary.dir.deleteFile(std.testing.io, "assets/runtime.wasm");
    try fixture.write("bundle/docs/index.html", "Collision");
    try std.testing.expectError(
        error.PageAssetCollision,
        site.website.preflight(allocator, std.testing.io, fixture.options),
    );
    try fixture.temporary.dir.deleteFile(std.testing.io, "bundle/docs/index.html");
    try fixture.temporary.dir.symLink(std.testing.io, "site.css", "assets/alias", .{});
    try std.testing.expectError(
        error.UnsupportedFileKind,
        site.website.preflight(allocator, std.testing.io, fixture.options),
    );
}

test "release installs a validated prefixed site and excludes template-only inputs" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    try fixture.write("dist/examples/generated/obsolete.bfbs", "Old example");
    try fixture.write("bundle/examples/sources/rocket.fbs", "table Rocket {}");
    const result = try fixture.build();
    try std.testing.expectEqual(@as(usize, 2), result.pages);
    try std.testing.expect(result.references >= 4);
    try contains(
        try fixture.read("dist/index.html"),
        "data-runtime=\"/flatzz-site/assets/runtime.wasm\"",
    );
    try std.testing.expectEqualStrings(
        "\x00asm\x01\x00\x00\x00",
        try fixture.read("dist/assets/runtime.wasm"),
    );
    try std.testing.expectEqualStrings(
        "table Rocket {}",
        try fixture.read("dist/examples/sources/rocket.fbs"),
    );
    try std.testing.expect(!try site.files.exists(
        std.testing.io,
        try fixture.path("dist/examples/generated/obsolete.bfbs"),
    ));
    try std.testing.expect(!try site.files.exists(
        std.testing.io,
        try fixture.path("dist/_partials"),
    ));
}

test "failed Zine layout links fragments and process preserve prior output" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    const allocator = fixture.arena.allocator();
    try fixture.write("dist/keep", "Previous valid site");
    const layout = try fixture.read("layouts/content.shtml");
    try fixture.write("layouts/content.shtml", "<extend template=\"missing.shtml\"></extend>");
    try fixture.expectFailure(error.ZineFailed);
    try fixture.write("layouts/content.shtml", layout);
    const source = try fixture.read("content/docs/index.smd");
    for ([_]struct { link: []const u8, failure: anyerror }{
        .{
            .link = "<a href=\"/flatzz-site/missing/\">Broken</a>",
            .failure = error.MissingLocalReference,
        },
        .{ .link = "<a href=\"../#missing\">Broken</a>", .failure = error.MissingFragment },
    }) |broken| {
        try fixture.write("content/docs/index.smd", try std.fmt.allocPrint(
            allocator,
            "{s}\n```=html\n{s}\n```\n",
            .{ source, broken.link },
        ));
        try fixture.expectFailure(broken.failure);
    }
    try fixture.write("content/docs/index.smd", source);
    const engine = fixture.options.zine_executable;
    fixture.options.zine_executable = try std.Io.Dir.cwd().realPathFileAlloc(
        std.testing.io,
        paths.interrupted_engine,
        allocator,
    );
    try fixture.expectFailure(error.ZineFailed);
    fixture.options.zine_executable = try fixture.path("missing-engine");
    try fixture.expectFailure(error.FileNotFound);
    fixture.options.zine_executable = engine;
    _ = try fixture.build();
    try std.testing.expect(!try site.files.exists(std.testing.io, try fixture.path("dist/keep")));
}

test "release rejects output overlapping authored sources or its generated bundle" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    for ([_][]const u8{
        ".",     "bundle", "bundle/nested", "assets",    "content",    "layouts",
        "tools", "wasm",   "tests",         "build.zig", "zine.ziggy", ".zig-cache",
    }) |destination| {
        fixture.options.output_directory = destination;
        try std.testing.expectError(error.OutputOverlapsSource, fixture.build());
    }
    var aliases = std.testing.tmpDir(.{});
    defer aliases.cleanup();
    try aliases.dir.symLink(
        std.testing.io,
        fixture.options.site_directory,
        "site",
        .{ .is_directory = true },
    );
    try aliases.dir.symLink(
        std.testing.io,
        fixture.options.bundle_directory,
        "bundle",
        .{ .is_directory = true },
    );
    const allocator = fixture.arena.allocator();
    const alias_root = try aliases.dir.realPathFileAlloc(std.testing.io, ".", allocator);
    for ([_][]const u8{ "site/assets", "bundle/nested" }) |alias| {
        fixture.options.output_directory = try std.fs.path.join(allocator, &.{ alias_root, alias });
        try std.testing.expectError(error.OutputOverlapsSource, fixture.build());
    }
    try std.testing.expectEqualStrings(
        "body { color: coral; }\n",
        try fixture.read("assets/site.css"),
    );
}

fn httpRequest(
    allocator: std.mem.Allocator,
    address: std.Io.net.IpAddress,
    method: []const u8,
    target: []const u8,
) ![]const u8 {
    const io = std.testing.io;
    const stream = try address.connect(io, .{ .mode = .stream });
    defer stream.close(io);
    var write_buffer: [1024]u8 = undefined;
    var writer = stream.writer(io, &write_buffer);
    try writer.interface.print(
        "{s} {s} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        .{ method, target },
    );
    try writer.interface.flush();
    var response: std.Io.Writer.Allocating = .init(allocator);
    var expected_length: ?usize = null;
    var read_buffer: [8192]u8 = undefined;
    var chunks = [_][]u8{&read_buffer};
    const timeout: std.Io.Timeout = .{
        .duration = .{ .raw = .fromSeconds(5), .clock = .awake },
    };
    while (true) {
        const result = try io.operateTimeout(.{
            .net_read = .{ .socket_handle = stream.socket.handle, .data = &chunks },
        }, timeout);
        const count = (try result.net_read).data_len;
        if (count == 0) break;
        try response.writer.writeAll(read_buffer[0..count]);
        if (expected_length == null) {
            if (std.mem.indexOf(u8, response.written(), "\r\n\r\n")) |header_end| {
                expected_length = header_end + 4;
                if (!std.mem.eql(u8, method, "HEAD")) {
                    var headers = std.mem.splitSequence(
                        u8,
                        response.written()[0..header_end],
                        "\r\n",
                    );
                    while (headers.next()) |header| {
                        const colon = std.mem.indexOfScalar(u8, header, ':') orelse continue;
                        if (std.ascii.eqlIgnoreCase(header[0..colon], "content-length"))
                            expected_length.? += try std.fmt.parseInt(
                                usize,
                                std.mem.trim(u8, header[colon + 1 ..], " "),
                                10,
                            );
                    }
                }
            }
        }
        if (expected_length) |length| if (response.written().len >= length) break;
    }
    return response.toOwnedSlice();
}

test "live preview serves Wasm and reloads edited SuperMD content" {
    var fixture = try Fixture.init();
    defer fixture.deinit();
    const io = std.testing.io;
    const allocator = fixture.arena.allocator();
    var reservation = try (std.Io.net.IpAddress{ .ip4 = .loopback(0) }).listen(io, .{});
    const address = reservation.socket.address;
    reservation.deinit(io);
    fixture.options.port = address.getPort();
    var child = try std.process.spawn(io, .{
        .argv = try site.website.arguments(allocator, io, fixture.options, null),
        .cwd = .{ .path = fixture.options.site_directory },
        .stderr = .ignore,
    });
    defer child.kill(io);
    var home: ?[]const u8 = null;
    for (0..100) |_| {
        home = httpRequest(allocator, address, "GET", "/") catch {
            try io.sleep(.fromMilliseconds(50), .awake);
            continue;
        };
        break;
    }
    try contains(home orelse return error.PreviewDidNotStart, "200 OK");
    try contains(home.?, "/__zine/zinereload.js");
    try contains(home.?, "data-runtime=\"/assets/runtime.wasm\"");
    const idle = try address.connect(io, .{ .mode = .stream });
    defer idle.close(io);
    const head = try httpRequest(allocator, address, "HEAD", "/assets/runtime.wasm");
    try contains(head, "content-type: application/wasm");
    try contains(head, "content-length: 8");
    const end = (std.mem.indexOf(u8, head, "\r\n\r\n") orelse return error.MissingHttpHeaders) + 4;
    try std.testing.expectEqual(end, head.len);
    try contains(try httpRequest(allocator, address, "GET", "/missing/"), "404 Not Found");
    try fixture.write("content/docs/index.smd", try std.fmt.allocPrint(
        allocator,
        "{s}\nLive reload fixture.\n",
        .{try fixture.read("content/docs/index.smd")},
    ));
    for (0..100) |_| {
        try io.sleep(.fromMilliseconds(50), .awake);
        const updated = try httpRequest(allocator, address, "GET", "/docs/");
        if (std.mem.indexOf(u8, updated, "Live reload fixture.") != null) break;
    } else return error.LiveReloadDidNotUpdate;
    try fixture.write("assets/site.css", "body { color: amber; }\n");
    for (0..100) |_| {
        try io.sleep(.fromMilliseconds(50), .awake);
        const updated = try httpRequest(allocator, address, "GET", "/assets/site.css");
        if (std.mem.indexOf(u8, updated, "body { color: amber; }") != null) return;
    }
    return error.LiveReloadDidNotUpdate;
}
