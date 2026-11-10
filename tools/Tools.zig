//! Declare native Zine commands, public library artifacts, and browser test runners.
//! The root build owns named commands and prerequisites. The native coordinator
//! validates release output and runs the live server; generated content stays cached.
const std = @import("std");
const Build = std.Build;
const Step = Build.Step;
const Self = @This();

builder: *Build,
library: *Build.Dependency,
compiler: *Step.Compile,
executable: *Step.Compile,
target: Build.ResolvedTarget,

/// Cache-backed official source and generated schema catalogue.
pub const Catalogue = struct {
    directory: Build.LazyPath,
};

/// Compiler-owned raw viewers and site-owned fragments, both in the build cache.
pub const Documentation = struct {
    raw_directory: Build.LazyPath,
    prepared_directory: Build.LazyPath,
};

/// Identical engine and generated assets for a release and live preview.
pub const SiteAssets = struct {
    zine: *Step.Compile,
    bundle: Build.LazyPath,
};

/// Native coordinator command; paths and artifacts are owned by the build graph.
pub const Command = union(enum) {
    clean,
    catalog,
    @"prepare-api": Build.LazyPath,
    build: SiteAssets,
    serve: SiteAssets,
};

pub const Tests = struct {
    content: *Step,
    runtime: *Step,
    compiler: *Step,
    catalogue: *Step,
    documentation: *Step,
    wasm: *Step,
};

/// Resolve the Zig dependency once; website inputs and tooling stay in this project.
pub fn init(builder: *Build) Self {
    const target = builder.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding });
    const library = builder.dependency("flatzz", .{
        .target = target,
        .optimize = .ReleaseSmall,
        .@"schema-tools" = true,
        .@"wasm-compiler" = true,
    });
    const executable = builder.addExecutable(.{
        .name = "flatzz-site",
        .root_module = builder.createModule(.{
            .root_source_file = builder.path("tools/site.zig"),
            .target = builder.graph.host,
            .optimize = .ReleaseSafe,
        }),
    });
    builder.installArtifact(executable);
    return .{
        .builder = builder,
        .executable = executable,
        .library = library,
        .compiler = library.artifact("flatzz"),
        .target = target,
    };
}

/// Track discovery as well as file bytes so additions, removals, and edits rebuild.
fn trackExamples(self: Self, command: *Step.Run, relative: []const u8) !void {
    const builder = self.builder;
    const root = self.library.path(relative);
    builder.dependOnDirectoryContents(root);
    const build_io = builder.graph.io;
    var directory = try self.library.builder.root.openDir(build_io, relative, .{
        .iterate = true,
    });
    defer directory.close(build_io);
    var entries = directory.iterate();
    while (try entries.next(build_io)) |entry| {
        if (std.mem.startsWith(u8, entry.name, ".") or
            std.mem.eql(u8, entry.name, "zig-out") or
            std.mem.eql(u8, entry.name, "node_modules")) continue;
        const source = root.path(builder, entry.name);
        switch (entry.kind) {
            .directory => try self.trackExamples(command, builder.fmt("{s}/{s}", .{
                relative, entry.name,
            })),
            .file => command.addFileInput(source),
            else => {},
        }
    }
}

/// Discover official examples and invoke the native compiler for Zig/JSON/BFBS output.
/// Directory discovery and original file bytes are tracked; output stays in the cache.
pub fn addCatalog(self: Self) Catalogue {
    const generate = self.addRun(.catalog, &.{});
    const directory = generate.addOutputDirectoryArg("examples");
    self.trackExamples(generate, "example") catch @panic("cannot read official examples");

    generate.addFileArg(self.builder.path("wasm/presets.json"));
    return .{ .directory = directory };
}

/// Compile the fixed-buffer demonstrations against the discovered generated schemas.
pub fn addCompile(self: Self, catalogue: Catalogue) *Step.Compile {
    const builder = self.builder;
    const runtime = self.library.module("flatzz");
    const module = builder.createModule(.{
        .root_source_file = builder.path("wasm/main.zig"),
        .target = self.target,
        .optimize = .ReleaseSmall,
        .imports = &.{.{ .name = "flatzz", .module = runtime }},
    });
    const presets = std.json.parseFromSlice(
        std.json.Value,
        builder.allocator,
        @embedFile("../wasm/presets.json"),
        .{},
    ) catch @panic("invalid runtime presets");
    var entries = presets.value.object.iterator();
    while (entries.next()) |preset| {
        const stem = preset.key_ptr.*[0 .. preset.key_ptr.len - ".fbs".len];
        module.addImport(std.fs.path.basename(stem), builder.createModule(.{
            .root_source_file = catalogue.directory.path(
                builder,
                builder.fmt("generated/{s}.zig", .{stem}),
            ),
            .target = self.target,
            .optimize = .ReleaseSmall,
            .imports = &.{.{ .name = "flatzz", .module = runtime }},
        }));
    }
    module.export_symbol_names = &.{
        "inputPointer",  "inputCapacity", "render", "framePointer", "frameLength",
        "reportPointer", "reportLength",
    };
    const executable = builder.addExecutable(.{ .name = "flatzz-home", .root_module = module });
    executable.entry = .disabled;
    executable.export_memory = true;
    executable.stack_size = 256 * 1024;
    executable.max_memory = 1024 * 1024;
    return executable;
}

/// Emit the public APIs directly, then apply the site shell to Zig's standard viewer.
/// As in zast-site, the site owns preparation and reads guides from the library checkout.
pub fn addApiDocumentation(self: Self) Documentation {
    const builder = self.builder;
    const host = builder.dependency("flatzz", .{
        .target = builder.graph.host,
        .optimize = .Debug,
        .@"schema-tools" = false,
        .@"wasm-compiler" = false,
    });
    const runtime = builder.addObject(.{
        .name = "runtime",
        .root_module = host.module("flatzz"),
    });
    const compiler = builder.addObject(.{
        .name = "compiler",
        .root_module = host.module("flatzz_compiler"),
    });
    const bundle = builder.addWriteFiles();
    _ = bundle.addCopyDirectory(runtime.getEmittedDocs(), ".", .{});
    _ = bundle.addCopyDirectory(compiler.getEmittedDocs(), "compiler", .{});
    _ = bundle.addCopyFile(self.library.path("README.md"), "guides/README.md");
    _ = bundle.addCopyFile(self.library.path("docs/examples.md"), "guides/examples.md");
    _ = bundle.addCopyFile(self.library.path("docs/wasm.md"), "guides/wasm.md");
    _ = bundle.addCopyDirectory(self.library.path("docs/assets"), "guides/assets", .{});
    const directory = bundle.getDirectory();
    const prepare = self.addRun(.{ .@"prepare-api" = directory }, &.{});
    const prepared = prepare.addOutputDirectoryArg("reference");
    for ([_][]const u8{ "", "compiler/" }) |prefix| {
        for ([_][]const u8{ "index.html", "main.js", "main.wasm", "sources.tar" }) |name| {
            prepare.addFileInput(directory.path(builder, builder.fmt("{s}{s}", .{ prefix, name })));
        }
    }
    return .{
        .raw_directory = directory,
        .prepared_directory = prepared,
    };
}

/// Assemble only generated assets. Zine owns pages, shared layouts, and static assets.
pub fn addSiteAssets(
    self: Self,
    catalogue: Catalogue,
    documentation: Documentation,
    runtime: *Step.Compile,
) Build.LazyPath {
    const builder = self.builder;
    const bundle = builder.addWriteFiles();
    _ = bundle.addCopyDirectory(catalogue.directory, "examples", .{});
    _ = bundle.addCopyDirectory(
        documentation.raw_directory.path(builder, "guides"),
        "docs/downloads",
        .{},
    );
    _ = bundle.addCopyFile(runtime.getEmittedBin(), "assets/runtime.wasm");
    _ = bundle.addCopyFile(
        self.library.artifact("flatzz-compiler-wasm").getEmittedBin(),
        "assets/flatzz-compiler.wasm",
    );
    _ = bundle.addCopyFile(builder.path("wasm/compiler.mjs"), "assets/compiler.mjs");
    for ([_][]const u8{ "runtime", "compiler" }) |name| {
        for ([_][]const u8{ "head", "body" }) |fragment| {
            _ = bundle.addCopyFile(
                documentation.prepared_directory.path(builder, builder.fmt("{s}/{s}.html", .{
                    name, fragment,
                })),
                builder.fmt("_partials/{s}-api-{s}.html", .{ name, fragment }),
            );
        }
        for ([_][]const u8{ "main.js", "main.wasm", "sources.tar.gz" }) |filename| {
            _ = bundle.addCopyFile(
                documentation.prepared_directory.path(builder, builder.fmt("{s}/{s}", .{
                    name, filename,
                })),
                builder.fmt("docs/api/{s}/{s}", .{ name, filename }),
            );
        }
    }
    return bundle.getDirectory();
}

/// Schedule native release/preview using the same artifact paths and generated bundle.
pub fn addRun(self: Self, command: Command, dependencies: []const *Step) *Step.Run {
    // Keep the cache input path stable when installation and preparation run in parallel.
    const runner = self.builder.addRunFile(self.executable.getEmittedBin());
    runner.addArg(@tagName(command));
    runner.setCwd(self.builder.path("."));
    runner.has_side_effects = switch (command) {
        .catalog, .@"prepare-api" => false,
        .clean, .build, .serve => true,
    };
    switch (command) {
        .clean => {},
        .catalog => {
            runner.addArtifactArg2(self.compiler, .{ .make_absolute = true });
            runner.addDirectoryArg2(self.library.path("example"), .{ .make_absolute = true });
        },
        .@"prepare-api" => |directory| {
            runner.addDirectoryArg2(directory, .{ .make_absolute = true });
        },
        .build, .serve => |assets| {
            runner.addArtifactArg2(assets.zine, .{ .make_absolute = true });
            runner.addDirectoryArg2(assets.bundle, .{ .make_absolute = true });
        },
    }
    for (dependencies) |dependency| runner.step.dependOn(dependency);
    return runner;
}

/// Test the complete release, native failure boundaries, and public compiler/runtime ABIs.
pub fn addTests(
    self: Self,
    wasm: *Step.Compile,
    documentation: Documentation,
    assets: SiteAssets,
    release: *Step,
) Tests {
    const builder = self.builder;
    const paths = builder.addOptions();
    paths.addOptionPath("zine_executable", assets.zine.getEmittedBin());
    const interrupted = builder.addExecutable(.{
        .name = "interrupted-engine",
        .root_module = builder.createModule(.{
            .root_source_file = builder.path("tests/interrupted_engine.zig"),
            .target = builder.graph.host,
            .optimize = .ReleaseSafe,
        }),
    });
    paths.addOptionPath("interrupted_engine", interrupted.getEmittedBin());
    const content_module = builder.createModule(.{
        .root_source_file = builder.path("tests/site.zig"),
        .target = builder.graph.host,
        .optimize = .Debug,
    });
    content_module.addOptions("paths", paths);
    content_module.addImport("site", self.executable.root_module);
    const content = builder.addRunArtifact(builder.addTest(.{ .root_module = content_module }));
    content.step.dependOn(release);
    const directory = builder.path("dist");
    const compiler_wasm = self.library.artifact("flatzz-compiler-wasm").getEmittedBin();
    const runtime = self.node("tests/runtime.cjs");
    runtime.addFileArg(wasm.getEmittedBin());
    const compiler = self.node("tests/compiler.cjs");
    compiler.addFileArg(compiler_wasm);
    compiler.addArg(builder.graph.zig_exe);
    compiler.addDirectoryArg2(self.library.path("."), .{ .make_absolute = true });
    compiler.addDirectoryArg2(directory, .{ .make_absolute = true });
    const catalogue = self.node("tests/catalogue.cjs");
    catalogue.addArtifactArg2(self.executable, .{ .make_absolute = true });
    catalogue.addArtifactArg2(self.compiler, .{ .make_absolute = true });
    const api = self.node("tests/documentation.cjs");
    api.addArtifactArg2(self.executable, .{ .make_absolute = true });
    api.addDirectoryArg2(documentation.raw_directory, .{ .make_absolute = true });
    api.addDirectoryArg2(directory, .{ .make_absolute = true });
    const contracts = self.node("tests/wasm/compiler.cjs");
    contracts.addFileArg(compiler_wasm);
    contracts.addFileArg2(builder.path("wasm/compiler.mjs"), .{ .make_absolute = true });
    contracts.addArtifactArg2(self.compiler, .{ .make_absolute = true });
    contracts.addArg(builder.graph.zig_exe);
    contracts.addDirectoryArg2(self.library.path("."), .{ .make_absolute = true });
    contracts.addFileInput(builder.path("tests/wasm/worker.cjs"));
    for ([_]*Step.Run{ runtime, compiler, catalogue, api }) |runner| {
        runner.step.dependOn(release);
    }
    return .{
        .content = &content.step,
        .runtime = &runtime.step,
        .compiler = &compiler.step,
        .catalogue = &catalogue.step,
        .documentation = &api.step,
        .wasm = &contracts.step,
    };
}

fn node(self: Self, script: []const u8) *Step.Run {
    const command = self.builder.addSystemCommand(&.{"node"});
    command.addFileArg(self.builder.path(script));
    command.setCwd(self.builder.path("."));
    return command;
}
