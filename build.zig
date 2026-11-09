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
    const wasm = tools.addCompile(catalog);
    const api = tools.addApiDocumentation();
    const release = tools.addRun(.{ .build = .{
        .zine = zine,
        .bundle = tools.addSiteAssets(catalog, api, wasm),
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
    const compiler_wasm = tools.library.artifact("flatzz-compiler-wasm").getEmittedBin();
    const contracts = tools.node("tests/wasm/compiler.cjs");
    contracts.addFileArg(compiler_wasm);
    contracts.addFileArg2(builder.path("wasm/compiler.mjs"), .{ .make_absolute = true });
    contracts.addArtifactArg2(tools.compiler, .{ .make_absolute = true });
    contracts.addArg(builder.graph.zig_exe);
    contracts.addDirectoryArg2(tools.library.path("."), .{ .make_absolute = true });
    contracts.addFileInput(builder.path("tests/wasm/worker.cjs"));
    tests.dependOn(&contracts.step);
    const runtime = tools.node("tests/runtime.cjs");
    runtime.addFileArg(wasm.getEmittedBin());
    const compiler = tools.node("tests/compiler.cjs");
    compiler.addFileArg(compiler_wasm);
    compiler.addArg(builder.graph.zig_exe);
    compiler.addDirectoryArg2(tools.library.path("."), .{ .make_absolute = true });
    compiler.addDirectoryArg2(builder.path("dist"), .{ .make_absolute = true });
    for ([_]*std.Build.Step.Run{ runtime, compiler }) |runner| {
        runner.step.dependOn(&release.step);
        tests.dependOn(&runner.step);
    }
    const docs = tools.node("tests/documentation.cjs");
    docs.addArtifactArg2(tools.executable, .{ .make_absolute = true });
    docs.addDirectoryArg2(api.raw_directory, .{ .make_absolute = true });
    docs.addDirectoryArg2(builder.path("dist"), .{ .make_absolute = true });
    docs.step.dependOn(&release.step);
    tests.dependOn(&docs.step);
}
