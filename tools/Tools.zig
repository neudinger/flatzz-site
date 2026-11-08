//! Wire native site preparation to the website build.
const std = @import("std");
const Build = std.Build;
const Step = Build.Step;
const Self = @This();

builder: *Build,
executable: *Step.Compile,
library: *Build.Dependency,
compiler: *Step.Compile,
target: Build.ResolvedTarget,

/// Cache-backed official source and generated schema catalogue.
pub const Catalogue = struct {
    directory: Build.LazyPath,
};

/// Engine and generated assets for the release.
pub const SiteAssets = struct {
    zine: *Step.Compile,
    bundle: Build.LazyPath,
};

pub const Command = union(enum) {
    build: SiteAssets,
    catalog,
};

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
    const generate = self.addRun(.catalog);
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

pub fn addSiteAssets(
    self: Self,
    catalogue: Catalogue,
    runtime: *Step.Compile,
) Build.LazyPath {
    const builder = self.builder;
    const bundle = builder.addWriteFiles();
    _ = bundle.addCopyDirectory(catalogue.directory, "examples", .{});
    _ = bundle.addCopyFile(runtime.getEmittedBin(), "assets/runtime.wasm");
    _ = bundle.addCopyFile(
        self.library.artifact("flatzz-compiler-wasm").getEmittedBin(),
        "assets/flatzz-compiler.wasm",
    );
    _ = bundle.addCopyFile(builder.path("wasm/compiler.mjs"), "assets/compiler.mjs");
    return bundle.getDirectory();
}

pub fn addRun(self: Self, command: Command) *Step.Run {
    // Keep the cache input path stable when installation and preparation run in parallel.
    const runner = self.builder.addRunFile(self.executable.getEmittedBin());
    runner.addArg(@tagName(command));
    runner.setCwd(self.builder.path("."));
    runner.has_side_effects = switch (command) {
        .catalog => false,
        .build => true,
    };
    switch (command) {
        .catalog => {
            runner.addArtifactArg2(self.compiler, .{ .make_absolute = true });
            runner.addDirectoryArg2(self.library.path("example"), .{ .make_absolute = true });
        },
        .build => |assets| {
            runner.addArtifactArg2(assets.zine, .{ .make_absolute = true });
            runner.addDirectoryArg2(assets.bundle, .{ .make_absolute = true });
        },
    }
    return runner;
}

pub fn node(self: Self, script: []const u8) *Step.Run {
    const command = self.builder.addSystemCommand(&.{"node"});
    command.addFileArg(self.builder.path(script));
    command.setCwd(self.builder.path("."));
    return command;
}
