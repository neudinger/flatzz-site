/** The build copies official sources and emits this catalogue; no schemas live in the site repo. */
const encodePath = value => value.split("/").map(encodeURIComponent).join("/");

export async function loadExamples(base = new URL("../examples/", import.meta.url)) {
  async function asset(path, binary = false) {
    const response = await fetch(new URL(encodePath(path), base));
    if (!response.ok) throw new Error(`Cannot load example ${path}`);
    return binary ? new Uint8Array(await response.arrayBuffer()) : response.text();
  }
  const catalog = JSON.parse(await asset("catalog.json"));
  await Promise.all(catalog.schemas.map(async example => {
    const [files, bytes] = await Promise.all([
      Promise.all(example.files.map(async name => [name, await asset(`sources/${name}`)])),
      asset(`generated/${example.key}.bfbs`, true),
    ]);
    example.original = { entry: example.entry, files: Object.fromEntries(files) };
    example.project = structuredClone(example.original);
    example.activeFile = example.original.entry;
    example.binary = { name: `${example.title}.bfbs`, bytes };
  }));
  return catalog;
}

/** Byte offsets are available only for the complete, unedited precompiled project. */
export function isOriginalProject(project, original) {
  return project.entry === original.entry
    && Object.keys(project.files).length === Object.keys(original.files).length
    && Object.entries(original.files).every(([name, source]) => project.files[name] === source);
}
