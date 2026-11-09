//! Run the Zine release and prepare its build-owned inputs.
const std = @import("std");
const catalog = @import("catalog.zig");
const api = @import("api.zig");
const website = @import("website.zig");

pub fn main(init: std.process.Init) !void {
    var arena = std.heap.ArenaAllocator.init(init.gpa);
    defer arena.deinit();
    const allocator = arena.allocator();
    const arguments = try init.minimal.args.toSlice(allocator);
    const Command = enum { build, catalog, @"prepare-api" };
    if (arguments.len < 2) return error.ExpectedCommand;
    const command = std.meta.stringToEnum(Command, arguments[1]) orelse return error.UnknownCommand;
    switch (command) {
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
        .@"prepare-api" => {
            if (arguments.len != 4) return error.ExpectedDocumentationInputAndOutput;
            try api.prepare(init.gpa, init.io, arguments[2], arguments[3]);
        },
        .build => {
            if (arguments.len != 4) return error.ExpectedZineAndBundlePaths;
            try website.build(allocator, init.io, .{
                .zine_executable = arguments[2],
                .bundle_directory = arguments[3],
            });
        },
    }
}
