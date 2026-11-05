//! Publish Zine pages and the generated assets declared by the build graph.
const std = @import("std");
const files = @import("files.zig");

pub const Options = struct {
    zine_executable: []const u8,
    bundle_directory: []const u8,
    site_directory: []const u8 = ".",
};

fn partial(path: []const u8) bool {
    return std.mem.startsWith(u8, path, "_partials/");
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

pub fn build(allocator: std.mem.Allocator, io: std.Io, options: Options) !void {
    const base = try std.Io.Dir.cwd().realPathFileAlloc(io, options.site_directory, allocator);
    var command: std.ArrayList([]const u8) = .empty;
    try command.append(allocator, try std.Io.Dir.cwd().realPathFileAlloc(
        io,
        options.zine_executable,
        allocator,
    ));
    try command.appendSlice(allocator, &.{ "release", "--output=dist", "--force" });
    try appendAssets(allocator, io, &command, base, options.bundle_directory, "");
    const assets = try std.fs.path.join(allocator, &.{ base, "assets" });
    try appendAssets(allocator, io, &command, base, assets, "assets");
    var child = try std.process.spawn(io, .{ .argv = command.items });
    defer child.kill(io);
    if (!(try child.wait(io)).success()) return error.ZineFailed;
}
