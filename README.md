# Flatzz site

Documentation and browser-local FlatBuffers playgrounds for [Flatzz](https://github.com/neudinger/flatzz).
Built with Zine, SuperMD, and shared SuperHTML layouts, following `zast-site`.


## Build and preview

```sh
zig build --fetch=all
zig build
zig build serve
zig build test
```

Output: `dist/`. Preview: <http://127.0.0.1:1991/>. Stop with Ctrl+C.
Content, layouts, and edits to existing CSS/browser assets reload during preview.
Restart after adding or removing assets; rebuild and restart after library, Wasm,
or generated catalogue changes.

`content/` contains pages, `layouts/` shared structure, `assets/` browser code and
artwork, and `tools/` site preparation and the native Zine coordinator. Official
examples and both API references come from Flatzz. Zig prepares both in the
build cache, and releases validate before replacing the ignored `dist/`.

`zig build docs` and `zig build examples` refresh the complete release;
`zig build wasm` compiles the runtime demonstrations, and `zig build test-wasm`
checks the reusable compiler ABI and native parity. `zig build clean` removes `dist/`.

FBS → Zig, FBS → JSON metadata, and BFBS → Zig run locally in the browser.
