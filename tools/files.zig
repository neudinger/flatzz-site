//! Small filesystem operations shared by the site tools. Paths are caller-owned.
const std = @import("std");

pub fn read(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(64 * 1024 * 1024));
}

pub fn write(io: std.Io, path: []const u8, contents: []const u8) !void {
    if (std.fs.path.dirname(path)) |parent| try std.Io.Dir.cwd().createDirPath(io, parent);
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = contents });
}

pub fn exists(io: std.Io, path: []const u8) !bool {
    _ = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch |failure| {
        switch (failure) {
            error.FileNotFound => return false,
            else => return failure,
        }
    };
    return true;
}

/// Test equality or descent at a path component boundary.
pub fn containsPath(parent: []const u8, child: []const u8) bool {
    return std.mem.eql(u8, parent, child) or
        (parent.len != 0 and child.len > parent.len and std.mem.startsWith(u8, child, parent) and
            (std.fs.path.isSep(parent[parent.len - 1]) or std.fs.path.isSep(child[parent.len])));
}

/// Resolve an owned preparation output in an existing parent directory.
/// Source is canonical. Do not follow the final component when replacing an output symlink.
pub fn preparationOutput(
    allocator: std.mem.Allocator,
    io: std.Io,
    source: []const u8,
    requested: []const u8,
) ![]u8 {
    const directory = std.Io.Dir.cwd();
    const workdir = try directory.realPathFileAlloc(io, ".", allocator);
    defer allocator.free(workdir);
    const absolute = try std.fs.path.resolveAlloc(allocator, &.{ workdir, requested });
    defer allocator.free(absolute);
    const parent = std.fs.path.dirname(absolute) orelse return error.InvalidOutputPath;
    const physical_parent = try directory.realPathFileAlloc(io, parent, allocator);
    defer allocator.free(physical_parent);
    const output = try std.fs.path.join(allocator, &.{
        physical_parent, std.fs.path.basename(absolute),
    });
    errdefer allocator.free(output);
    if (containsPath(output, workdir) or containsPath(output, source) or
        containsPath(source, output)) return error.OutputOverlapsSource;
    return output;
}

/// Return sorted relative file names; reject symlinks and special files.
/// The caller releases both the strings and their slice, or uses an arena.
pub fn list(allocator: std.mem.Allocator, io: std.Io, path: []const u8) ![][]const u8 {
    const directory = try std.Io.Dir.cwd().openDir(io, path, .{
        .iterate = true,
        .follow_symlinks = false,
    });
    defer directory.close(io);
    var walker = try directory.walk(allocator);
    defer walker.deinit();
    var names: std.ArrayList([]const u8) = .empty;
    errdefer {
        for (names.items) |name| allocator.free(name);
        names.deinit(allocator);
    }
    while (try walker.next(io)) |entry| switch (entry.kind) {
        .directory => {},
        .file => {
            const name = try allocator.dupe(u8, entry.path);
            errdefer allocator.free(name);
            try names.append(allocator, name);
        },
        else => return error.UnsupportedFileKind,
    };
    std.mem.sort([]const u8, names.items, {}, struct {
        fn lessThan(_: void, left: []const u8, right: []const u8) bool {
            return std.mem.lessThan(u8, left, right);
        }
    }.lessThan);
    return names.toOwnedSlice(allocator);
}

/// Create a unique sibling of the output so the final rename stays on one filesystem.
pub fn staging(allocator: std.mem.Allocator, io: std.Io, output: []const u8) ![]const u8 {
    var random: [16]u8 = undefined;
    io.random(&random);
    const path = try std.fmt.allocPrint(allocator, "{s}/.zine-build-{x}", .{
        std.fs.path.dirname(output) orelse ".", &random,
    });
    errdefer allocator.free(path);
    try std.Io.Dir.cwd().createDir(io, path, .default_dir);
    return path;
}

/// Replace an owned output with a complete sibling staging directory.
/// On rename failure restore the previous output before returning.
pub fn publish(
    allocator: std.mem.Allocator,
    io: std.Io,
    staged: []const u8,
    output: []const u8,
) !void {
    const directory = std.Io.Dir.cwd();
    const backup = try std.fmt.allocPrint(allocator, "{s}.previous", .{staged});
    defer allocator.free(backup);
    const had_previous = try exists(io, output);
    if (had_previous) try directory.rename(output, directory, backup, io);
    directory.rename(staged, directory, output, io) catch |failure| {
        if (had_previous) try directory.rename(backup, directory, output, io);
        return failure;
    };
    if (had_previous) try directory.deleteTree(io, backup);
}

pub fn replace(
    allocator: std.mem.Allocator,
    source: []const u8,
    original: []const u8,
    replacement: []const u8,
) ![]u8 {
    return std.mem.replaceOwned(u8, allocator, source, original, replacement);
}
