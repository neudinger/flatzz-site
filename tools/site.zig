//! Native Zine release and preview coordinator; browser tooling remains site-owned.
const std = @import("std");
const api = @import("api.zig");
const catalog = @import("catalog.zig");
pub const website = @import("website.zig");
pub const files = @import("files.zig");

pub const std_options: std.Options = .{ .log_level = .warn };

/// Remove the generated website while preserving sources and compiler caches.
pub fn clean(io: std.Io, directory: std.Io.Dir) !void {
    try directory.deleteTree(io, "dist");
}

/// Resolve the branch before passing the exact commit URL to Zig's package manager.
fn updateFlatzz(allocator: std.mem.Allocator, io: std.Io, zig_executable: []const u8) !void {
    const repository = "https://github.com/neudinger/flatzz";
    const branch = "refs/heads/main";
    const resolved = try std.process.run(allocator, io, .{
        .argv = &.{ "git", "ls-remote", "--exit-code", repository, branch },
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(64 * 1024),
    });
    defer allocator.free(resolved.stdout);
    defer allocator.free(resolved.stderr);
    if (!resolved.term.success()) {
        std.debug.print("{s}", .{resolved.stderr});
        return error.FlatzzRefLookupFailed;
    }

    const line = std.mem.trimEnd(u8, resolved.stdout, "\r\n");
    const commit, const ref = std.mem.cutScalar(u8, line, '\t') orelse return error.InvalidFlatzzRef;
    if (commit.len != 40 or !std.mem.eql(u8, ref, branch)) return error.InvalidFlatzzRef;
    for (commit) |digit| if (!std.ascii.isHex(digit)) return error.InvalidFlatzzRef;

    const url = try std.fmt.allocPrint(allocator, "git+{s}#{s}", .{ repository, commit });
    defer allocator.free(url);
    var fetch = try std.process.spawn(io, .{
        .argv = &.{ zig_executable, "fetch", "--save-exact=flatzz", url },
    });
    defer fetch.kill(io);
    if (!(try fetch.wait(io)).success()) return error.FlatzzFetchFailed;
}

pub fn main(init: std.process.Init) !void {
    var arena = std.heap.ArenaAllocator.init(init.gpa);
    defer arena.deinit();
    const allocator = arena.allocator();
    const arguments = try init.minimal.args.toSlice(allocator);
    const Command = enum { clean, catalog, @"update-flatzz", @"prepare-api", build, serve };
    if (arguments.len < 2) return error.ExpectedCommand;
    const command = std.meta.stringToEnum(Command, arguments[1]) orelse return error.UnknownCommand;
    switch (command) {
        .clean => {
            if (arguments.len != 2) return error.UnexpectedArguments;
            try clean(init.io, .cwd());
        },
        .catalog => {
            if (arguments.len < 5 or arguments.len > 6)
                return error.ExpectedCompilerExamplesOutputAndOptionalPresets;
            try catalog.generate(
                init.gpa,
                init.io,
                arguments[2],
                arguments[3],
                arguments[4],
                if (arguments.len == 6) arguments[5] else null,
            );
        },
        .@"update-flatzz" => {
            if (arguments.len != 3) return error.ExpectedZigExecutable;
            try updateFlatzz(allocator, init.io, arguments[2]);
        },
        .@"prepare-api" => {
            if (arguments.len != 4) return error.ExpectedDocumentationInputAndOutput;
            try api.prepare(init.gpa, init.io, arguments[2], arguments[3]);
        },
        .build, .serve => {
            if (arguments.len < 4 or arguments.len > 5) return error.ExpectedZineAndBundlePaths;
            var options: website.Options = .{
                .zine_executable = arguments[2],
                .bundle_directory = arguments[3],
            };
            if (command == .serve) {
                if (arguments.len == 5)
                    options.port = try std.fmt.parseInt(u16, arguments[4], 10);
                return website.serve(allocator, init.io, options);
            }
            if (arguments.len == 5) options.output_directory = arguments[4];
            const result = try website.build(allocator, init.io, options);
            std.debug.print("Built {d} pages with {d} local references using Zine.\n", .{
                result.pages, result.references,
            });
        },
    }
}
