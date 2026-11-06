//! zvm-lock: 0.17.0
//! Coordinate Zine, the library compiler, official examples, and themed API references.
const std = @import("std");
const manifest = @import("build.zig.zon");
const Tools = @import("tools/Tools.zig");

comptime {
    const required_version = manifest.minimum_zig_version;
    if (!std.mem.eql(u8, @import("builtin").zig_version_string, required_version)) {
        @compileError("This site requires Zig " ++ required_version ++
            "; run `zvm run " ++ required_version ++ " build`.");
    }
}

pub fn build(builder: *std.Build) void {
    const zine = builder.dependency("zine", .{
        .target = builder.graph.host,
        .optimize = .ReleaseFast,
        .@"no-git-version" = true,
        .highlight = false,
    }).artifact("zine");
    const tools = Tools.init(builder);
    const catalog = tools.addCatalog();
    const release = tools.addRun(.{ .build = .{
        .zine = zine,
        .bundle = tools.addSiteAssets(catalog),
    } });
    builder.getInstallStep().dependOn(&release.step);
    const tests = builder.step("test", "Build and test the website");
    const published = tools.node("tests/stage.cjs");
    published.step.dependOn(&release.step);
    tests.dependOn(&published.step);
    const discovery = tools.node("tests/catalogue.cjs");
    discovery.addArtifactArg2(tools.executable, .{ .make_absolute = true });
    discovery.addArtifactArg2(tools.compiler, .{ .make_absolute = true });
    tests.dependOn(&discovery.step);
}
