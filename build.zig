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
    const assets: Tools.SiteAssets = .{
        .zine = zine,
        .bundle = tools.addSiteAssets(catalog, api, wasm),
    };
    const release = tools.addRun(.{ .build = assets }, &.{});
    const preview = tools.addRun(.{ .serve = assets }, &.{});
    const clean = tools.addRun(.clean, &.{});
    const tests = tools.addTests(wasm, api, assets, &release.step);
    const update_flatzz = if (@hasField(@TypeOf(manifest.dependencies.flatzz), "hash"))
        &tools.addRun(.{ .@"update-flatzz" = builder.graph.zig_exe }, &.{}).step
    else
        &builder.addFail("Enable the Flatzz GitHub pin in build.zig.zon first.").step;

    // Default build -> prepared library content + native Zine release + validation.
    builder.getInstallStep().dependOn(&release.step);

    inline for (.{
        .{
            .tag = .clean,
            .description = "Remove the generated release without rebuilding it",
            .prerequisites = .{&clean.step},
        },
        .{
            .tag = .@"update-flatzz",
            .description = "Pin Flatzz to the latest GitHub main commit",
            .prerequisites = .{update_flatzz},
        },
        .{
            .tag = .docs,
            .description = "Generate and theme both API references and copy the library guides",
            .prerequisites = .{&release.step},
        },
        .{
            .tag = .examples,
            .description = "Discover official examples and prepare the source browser",
            .prerequisites = .{&release.step},
        },
        .{
            .tag = .wasm,
            .description = "Build the compiler and runtime playground assets",
            .prerequisites = .{ &wasm.step, &tools.library.artifact("flatzz-compiler-wasm").step },
        },
        .{
            .tag = .@"test-wasm",
            .description = "Test the compiler ABI, native parity, and Wasm-generated Zig",
            .prerequisites = .{tests.wasm},
        },
        .{
            .tag = .@"test",
            .description = "Test playgrounds, APIs, official examples, and fixed-buffer runtime",
            .prerequisites = .{
                tests.content,       tests.runtime, tests.compiler, tests.catalogue,
                tests.documentation, tests.wasm,
            },
        },
        .{
            .tag = .serve,
            .description = "Preview with live reload at http://127.0.0.1:1991/",
            .prerequisites = .{&preview.step},
        },
    }) |command| {
        const step = builder.step(@tagName(command.tag), command.description);
        inline for (command.prerequisites) |prerequisite| step.dependOn(prerequisite);
    }
}
