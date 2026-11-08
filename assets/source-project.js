const decoder = new TextDecoder("utf-8", { fatal: true });

/** Read selected files completely before replacing a draft. No source leaves the browser. */
export async function readFbsProject(files, limits) {
  if (!files.length) throw new Error("Choose at least one FBS file.");
  if (files.length > limits.files) throw new Error(`Choose at most ${limits.files} FBS files.`);
  const names = files.map(file => file.name);
  if (new Set(names).size !== names.length) throw new Error("Choose files with unique filenames.");
  const bytes = files.reduce((total, file) => total + file.size + new TextEncoder().encode(file.name).length, 0);
  if (bytes > limits.source_bytes) throw new Error(`The FBS project exceeds ${limits.source_bytes} bytes.`);
  const contents = await Promise.all(files.map(async file => {
    if (!file.name.toLowerCase().endsWith(".fbs")) throw new Error("Choose .fbs schema files.");
    try { return [file.name, decoder.decode(await file.arrayBuffer())]; }
    catch { throw new Error(`${file.name}: the FBS file must contain valid UTF-8.`); }
  }));
  return { entry: names[0], files: Object.fromEntries(contents) };
}

export async function readBfbsFile(file, limits) {
  if (file.size > limits.input_bytes) throw new Error(`The BFBS file exceeds ${limits.input_bytes} bytes.`);
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), uploaded: true };
}

export function projectRequest(project, output = "zig") {
  const { [project.entry]: source, ...files } = project.files;
  return { input: "fbs", output, filename: project.entry, source, files };
}
