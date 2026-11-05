//! Run the Zine release and prepare its build-owned inputs.
const std = @import("std");
const website = @import("website.zig");

pub fn main(init: std.process.Init) !void {
    var arena = std.heap.ArenaAllocator.init(init.gpa);
    defer arena.deinit();
    const allocator = arena.allocator();
    const arguments = try init.minimal.args.toSlice(allocator);
    const Command = enum { build };
    if (arguments.len < 2) return error.ExpectedCommand;
    const command = std.meta.stringToEnum(Command, arguments[1]) orelse return error.UnknownCommand;
    switch (command) {
        .build => {
            if (arguments.len != 4) return error.ExpectedZineAndBundlePaths;
            try website.build(allocator, init.io, .{
                .zine_executable = arguments[2],
                .bundle_directory = arguments[3],
            });
        },
    }
}
