//! Test-only engine used to verify staging cleanup after abnormal termination.
const std = @import("std");

pub fn main() void {
    std.process.abort();
}
