//! Wire native site preparation to the website build.
const std = @import("std");
const Build = std.Build;
const Step = Build.Step;
const Self = @This();

builder: *Build,
executable: *Step.Compile,
/// Engine and generated assets for the release.
pub const SiteAssets = struct {
    zine: *Step.Compile,
    bundle: Build.LazyPath,
};

pub const Command = union(enum) {
    build: SiteAssets,
};

pub fn init(builder: *Build) Self {
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
    };
}

pub fn addSiteAssets(
    self: Self,
) Build.LazyPath {
    const builder = self.builder;
    const bundle = builder.addWriteFiles();
    return bundle.getDirectory();
}

pub fn addRun(self: Self, command: Command) *Step.Run {
    // Keep the cache input path stable when installation and preparation run in parallel.
    const runner = self.builder.addRunFile(self.executable.getEmittedBin());
    runner.addArg(@tagName(command));
    runner.setCwd(self.builder.path("."));
    runner.has_side_effects = switch (command) {
        .build => true,
    };
    switch (command) {
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
