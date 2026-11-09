# Flatzz site

Documentation for [Flatzz](https://github.com/neudinger/flatzz), built with
Zine and SuperMD. Build with Zig 0.17.0 and run tests with Node.js 22.

```sh
zig build --fetch=all
zig build
zig build test
```

The generated release is written to `dist/`.

The native build discovers examples from the pinned Flatzz package.

The freestanding Wasm compiler runs locally in the browser.

The playground supports FBS → Zig, FBS → JSON metadata, and BFBS → Zig.

The build publishes themed runtime and compiler APIs from Zig documentation.
