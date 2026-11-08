import { escapeHtml, highlight } from "./highlight.js?v=library-content-1";
import { SchemaRocket } from "./rocket.js?v=auto-catalogue-1";
import { SchemaCompiler } from "./compiler-client.js?v=comptime-buffers-1";
import { rootObject, schemaReport, usageExample } from "./schema-model.js?v=comptime-buffers-1";
import { projectRequest, readFbsProject, readBfbsFile } from "./source-project.js?v=wasm-playgrounds-1";
import { loadExamples, isOriginalProject } from "./examples.js?v=library-content-1";

let catalog = [];
const byId = name => document.getElementById(name);
const elements = Object.fromEntries([
  "engine-status", "runtime-error", "schema-code", "schema-editor", "generated-code", "schema-heading", "generated-heading",
  "example-select", "previous-example", "next-example", "example-position", "example-description",
  "motion-button", "motion-status", "code-size", "code-wrap", "copy-button", "download-button", "reset-button", "toast",
  "usage-code", "usage-note", "usage-status", "copy-usage", "usage-example", "output-kind", "input-kind", "editor-help",
  "source-project", "source-tabs", "entry-file", "fbs-files", "open-fbs", "binary-input", "bfbs-file", "open-bfbs",
  "binary-name", "binary-size", "binary-status", "schema-editor-shell", "compiler-workspace",
].map(name => [name, byId(name)]));
const tabs = [...document.querySelectorAll("[data-mode]")];
const rocket = new SchemaRocket(byId("schema-rocket"));
const compiler = new SchemaCompiler(receiveCompilation);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let engine;
let selected = 1;
let mode = "fbs-zig";
let report = null;
let generated = "";
let usage = "";
let root = "";
let fbsRoot = "";
let activeRequest;
let fileRevision = 0;
let limits;
let moving = !reduced.matches;
let toastTimer;
let editTimer;
let loaded = false;

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function drawSource(element, source, interactive = false) {
  const isSchema = element === elements["schema-code"];
  element.innerHTML = source.split("\n").map((line, index) => {
    const fields = report?.fields.filter(field => {
      const pattern = !isSchema && mode === "fbs-json"
        ? `"name":\\s*${escapeRegExp(JSON.stringify(field.name))}`
        : `(?:^|[\\s.])${escapeRegExp(field.name)}\\s*[:=]`;
      return new RegExp(pattern).test(line);
    }) || [];
    const rootLine = root && (isSchema ? new RegExp(`\\btable\\s+${escapeRegExp(fbsRoot)}\\b`).test(line)
      : line.startsWith(`pub const ${root} = struct`));
    const names = [...fields.map(field => field.name), ...(rootLine ? ["root"] : [])];
    const contents = `<span class="line-number" aria-hidden="true">${index + 1}</span><code>${highlight(line) || " "}</code>`;
    const attributes = names.length ? ` data-field="${escapeHtml(names[0])}" data-fields="${escapeHtml(JSON.stringify(names))}"` : "";
    return interactive && names.length
      ? `<button type="button" class="code-line"${attributes} aria-pressed="false" aria-label="Select ${escapeHtml(names[0])} from source">${contents}</button>`
      : `<div class="code-line"${isSchema ? attributes : ""}>${contents}</div>`;
  }).join("");
  if (isSchema) syncEditorScroll();
  else { element.scrollTop = 0; element.scrollLeft = 0; }
}
function syncEditorScroll() {
  elements["schema-code"].scrollTop = elements["schema-editor"].scrollTop;
  elements["schema-code"].scrollLeft = elements["schema-editor"].scrollLeft;
}
function highlightField({ name, reveal }) {
  for (const element of [elements["schema-code"], elements["generated-code"]]) {
    for (const line of element.querySelectorAll("[data-field]")) {
      const active = JSON.parse(line.dataset.fields).includes(name || "root");
      line.classList.toggle("active", active);
      if (line.tagName === "BUTTON") line.setAttribute("aria-pressed", String(active));
    }
  }
  if (reveal && mode !== "bfbs-zig") {
    const editor = elements["schema-editor"];
    const pattern = name ? new RegExp(`\\b${escapeRegExp(name)}\\s*:`) : new RegExp(`\\btable\\s+${escapeRegExp(fbsRoot)}\\b`);
    const match = pattern.exec(editor.value);
    if (match) editor.setSelectionRange(match.index, match.index + (name || fbsRoot).length);
  }
}
byId("schema-rocket").addEventListener("rocket-field", event => highlightField(event.detail));
elements["generated-code"].addEventListener("click", event => {
  const field = event.target.closest("[data-field]");
  if (field) rocket.select(field.dataset.field, { reveal: true });
});
elements["schema-editor"].addEventListener("scroll", syncEditorScroll);
for (const event of ["select", "click", "keyup"]) elements["schema-editor"].addEventListener(event, selectEditorField);
function selectEditorField() {
  const editor = elements["schema-editor"];
  const start = editor.value.lastIndexOf("\n", editor.selectionStart - 1) + 1;
  const end = editor.value.indexOf("\n", editor.selectionStart);
  const line = editor.value.slice(start, end < 0 ? undefined : end);
  const fields = (report?.fields || []).flatMap(field => {
    const match = new RegExp(`\\b${escapeRegExp(field.name)}\\s*:`).exec(line);
    return match ? [{ field, position: match.index }] : [];
  }).sort((left, right) => left.position - right.position);
  const field = fields.findLast(candidate => candidate.position <= editor.selectionStart - start)?.field;
  if (field) rocket.select(field.name);
}
function invalidate() {
  fileRevision++;
  compiler.invalidate();
  clearTimeout(editTimer);
  activeRequest = null;
}
function setPending(message = "Compiling schema…") {
  generated = "";
  usage = "";
  elements["engine-status"].textContent = message;
  elements["usage-status"].textContent = "UPDATING…";
  elements["runtime-error"].hidden = true;
  elements["schema-editor"].setAttribute("aria-invalid", "false");
  for (const name of ["copy-button", "download-button", "copy-usage"]) elements[name].disabled = true;
  drawSource(elements["generated-code"], mode === "fbs-json" ? "Preparing schema JSON…" : "// Preparing generated Zig…");
  byId("playground").setAttribute("aria-busy", "true");
}
function currentBinary() { return catalog[selected].upload || catalog[selected].binary; }
function outputStem() {
  const filename = mode === "bfbs-zig" ? currentBinary().name : catalog[selected].project.entry;
  return filename.split("/").pop().replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_.-]/g, "_") || "schema";
}
function compileCurrent() {
  const example = catalog[selected];
  activeRequest = mode === "bfbs-zig"
    ? { input: "bfbs", output: "zig", source: currentBinary().bytes }
    : projectRequest(example.project, mode === "fbs-json" ? "json" : "zig");
  compiler.compile(activeRequest);
}
elements["schema-editor"].addEventListener("input", () => {
  invalidate();
  const example = catalog[selected];
  example.project.files[example.activeFile] = elements["schema-editor"].value;
  drawSource(elements["schema-code"], elements["schema-editor"].value);
  setPending();
  editTimer = setTimeout(compileCurrent, 220);
});
function showSourceFile(filename) {
  const example = catalog[selected];
  example.activeFile = filename;
  elements["schema-heading"].textContent = filename;
  elements["schema-editor"].value = example.project.files[filename];
  elements["schema-editor"].scrollTop = 0;
  elements["schema-editor"].scrollLeft = 0;
  drawSource(elements["schema-code"], elements["schema-editor"].value);
  for (const button of elements["source-tabs"].children) button.setAttribute("aria-pressed", String(button.dataset.file === filename));
}
function updateProjectControls() {
  const example = catalog[selected];
  elements["source-tabs"].replaceChildren();
  elements["entry-file"].replaceChildren();
  for (const name of Object.keys(example.project.files)) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.file = name;
    button.textContent = name;
    button.addEventListener("click", () => showSourceFile(name));
    elements["source-tabs"].append(button);
    elements["entry-file"].add(new Option(name, name));
  }
  elements["entry-file"].value = example.project.entry;
  showSourceFile(example.activeFile);
}
function refreshWorkspace() {
  if (!loaded) return;
  invalidate();
  const binary = mode === "bfbs-zig";
  const json = mode === "fbs-json";
  for (const tab of tabs) {
    const active = tab.dataset.mode === mode;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  elements["compiler-workspace"].setAttribute("aria-labelledby", `mode-${mode}`);
  elements["source-project"].hidden = binary;
  elements["schema-editor-shell"].hidden = binary;
  elements["binary-input"].hidden = !binary;
  elements["usage-example"].hidden = json;
  elements["input-kind"].textContent = binary ? "BINARY SCHEMA" : "EDITABLE FBS";
  elements["output-kind"].textContent = json ? "SCHEMA JSON" : "GENERATED ZIG";
  elements["generated-code"].setAttribute("aria-label", json ? "Schema JSON, read only" : "Generated Zig code, read only");
  elements["generated-heading"].textContent = `${outputStem()}.${json ? "json" : "zig"}`;
  elements["copy-button"].textContent = json ? "Copy JSON" : "Copy Zig";
  elements["download-button"].textContent = json ? "Download JSON" : "Download Zig";
  elements["reset-button"].textContent = binary ? "Reset import" : "Reset schema";
  elements["editor-help"].textContent = binary ? "Import a binary schema to generate Zig locally."
    : json ? "Edit FBS to inspect schema metadata as JSON." : "Edit FBS to update Zig and the rocket.";
  if (binary) {
    const file = currentBinary();
    elements["schema-heading"].textContent = file.name;
    elements["binary-name"].textContent = file.name;
    elements["binary-size"].textContent = `${file.bytes.length.toLocaleString()} bytes`;
    elements["binary-status"].textContent = file.uploaded ? "Your binary schema" : "Example binary schema";
  } else updateProjectControls();
  report = null;
  setPending();
  compileCurrent();
}
function chooseExample(index, reset = false) {
  if (!loaded) return;
  selected = (index + catalog.length) % catalog.length;
  const example = catalog[selected];
  if (reset) {
    if (mode === "bfbs-zig") example.upload = null;
    else { example.project = structuredClone(example.original); example.activeFile = example.project.entry; }
  }
  elements["example-select"].value = example.key;
  elements["example-position"].textContent = `${String(selected + 1).padStart(2, "0")} / ${String(catalog.length).padStart(2, "0")}`;
  elements["example-description"].textContent = example.description;
  refreshWorkspace();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => { mode = tab.dataset.mode; refreshWorkspace(); });
  tab.addEventListener("keydown", event => {
    const direction = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : direction ? (index + direction + tabs.length) % tabs.length : null;
    if (next === null) return;
    event.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  });
}
elements["entry-file"].addEventListener("change", () => {
  catalog[selected].project.entry = elements["entry-file"].value;
  catalog[selected].activeFile = elements["entry-file"].value;
  refreshWorkspace();
});
elements["open-fbs"].addEventListener("click", () => elements["fbs-files"].click());
elements["open-bfbs"].addEventListener("click", () => elements["bfbs-file"].click());
async function importFiles(binary) {
  const input = elements[binary ? "bfbs-file" : "fbs-files"];
  const files = [...input.files];
  input.value = "";
  if (!files.length) return;
  invalidate();
  const revision = fileRevision;
  const example = catalog[selected];
  setPending("Reading selected files…");
  try {
    const result = binary ? await readBfbsFile(files[0], limits) : await readFbsProject(files, limits);
    if (revision !== fileRevision) return;
    if (binary) example.upload = result;
    else { example.project = result; example.activeFile = result.entry; }
    refreshWorkspace();
  } catch (error) { if (revision === fileRevision) showError(error.message); }
}
elements["fbs-files"].addEventListener("change", () => importFiles(false));
elements["bfbs-file"].addEventListener("change", () => importFiles(true));
function presetReport(example, request) {
  if (!engine || !example.runtime || mode !== "fbs-zig" || !isOriginalProject(example.project, example.original)
      || request.filename !== example.original.entry) return null;
  const input = encoder.encode(example.runtime.text);
  new Uint8Array(engine.memory.buffer, engine.inputPointer(), input.length).set(input);
  const status = engine.render(example.runtime.id, example.runtime.number, input.length, example.runtime.options);
  const output = decoder.decode(new Uint8Array(engine.memory.buffer, engine.reportPointer(), engine.reportLength()));
  if (status !== 0) throw new Error(output);
  return JSON.parse(output);
}
function receiveCompilation({ result, error, request }) {
  if (request !== activeRequest) return;
  byId("playground").setAttribute("aria-busy", "false");
  if (error) return showError(error);
  generated = result.output;
  limits = result.limits;
  for (const name of ["open-fbs", "open-bfbs"]) elements[name].disabled = false;
  elements["schema-editor"].maxLength = limits.input_bytes;
  const schema = result.schema;
  const object = schema && rootObject(schema);
  root = object?.zig_name || "";
  fbsRoot = object?.name.split(".").pop() || "";
  report = schema ? schemaReport(schema) : null;
  const frame = schema && presetReport(catalog[selected], request);
  if (frame) report = { ...frame, fields: frame.fields.map(field => {
    const declaration = report.fields.find(candidate => candidate.name === field.name);
    return { ...declaration, ...field, wire_type: declaration.wire_type };
  }) };
  if (mode !== "bfbs-zig") drawSource(elements["schema-code"], elements["schema-editor"].value);
  drawSource(elements["generated-code"], generated.trimEnd(), true);
  const sample = schema && mode !== "fbs-json" ? usageExample(schema, outputStem()) : null;
  usage = sample?.source || "";
  if (sample) drawSource(elements["usage-code"], usage.trimEnd());
  else drawSource(elements["usage-code"], "// A usage example is unavailable for this schema.");
  elements["usage-note"].textContent = sample?.note || result.note;
  elements["usage-status"].textContent = "FOLLOWS YOUR SCHEMA";
  if (report) rocket.update(report, root);
  else rocket.fail(result.note || "Add a table to give the rocket field stages.");
  elements["runtime-error"].hidden = true;
  elements["schema-editor"].setAttribute("aria-invalid", "false");
  elements["engine-status"].textContent = report?.schema_only ? `${report.fields.length} fields · schema metadata`
    : report ? `${report.fields.length} fields · ${report.length} B verified` : "Conversion complete";
  elements["example-description"].textContent = mode === "fbs-json" ? "Schema declarations and defaults as JSON."
    : mode === "bfbs-zig" ? "A binary schema converted to typed Zig." : catalog[selected].description;
  for (const name of ["copy-button", "download-button"]) elements[name].disabled = false;
  elements["copy-usage"].disabled = !usage;
}
function showError(message) {
  generated = "";
  usage = "";
  report = null;
  root = "";
  elements["runtime-error"].textContent = message;
  elements["runtime-error"].hidden = false;
  elements["schema-editor"].setAttribute("aria-invalid", "true");
  elements["engine-status"].textContent = mode === "bfbs-zig" ? "Choose a valid binary schema" : "Fix the schema to update";
  elements["usage-status"].textContent = "WAITING FOR VALID SCHEMA";
  elements["usage-note"].textContent = "A valid schema is needed to prepare a usage example.";
  drawSource(elements["generated-code"], mode === "fbs-json" ? "Schema JSON is unavailable until the input is valid."
    : "// Generated Zig is unavailable until the input is valid.");
  drawSource(elements["usage-code"], "// The usage example updates when the schema is valid.");
  rocket.fail("Correct or replace the schema to rebuild the rocket stages.");
  byId("playground").setAttribute("aria-busy", "false");
  for (const name of ["copy-button", "download-button", "copy-usage"]) elements[name].disabled = true;
}
function updateMotion() {
  const active = moving && !reduced.matches;
  rocket.setMotion(active);
  elements["motion-button"].textContent = active ? "Pause motion" : "Play motion";
  elements["motion-button"].setAttribute("aria-pressed", String(active));
  elements["motion-button"].disabled = reduced.matches;
  elements["motion-status"].textContent = reduced.matches ? "Reduced motion" : active ? "Interactive canvas" : "Motion paused";
}
elements["motion-button"].addEventListener("click", () => { moving = !moving; updateMotion(); });
reduced.addEventListener("change", updateMotion);
elements["example-select"].addEventListener("change", () => chooseExample(catalog.findIndex(example => example.key === elements["example-select"].value)));
elements["previous-example"].addEventListener("click", () => chooseExample(selected - 1));
elements["next-example"].addEventListener("click", () => chooseExample(selected + 1));
elements["reset-button"].addEventListener("click", () => chooseExample(selected, true));
elements["code-size"].addEventListener("change", () => { byId("playground").style.setProperty("--code-font-size", `${elements["code-size"].value}px`); syncEditorScroll(); });
elements["code-wrap"].addEventListener("change", () => {
  byId("playground").classList.toggle("wrap-code", elements["code-wrap"].checked);
  elements["schema-editor"].wrap = elements["code-wrap"].checked ? "soft" : "off";
  syncEditorScroll();
});
async function copySource(source, message) {
  try { await navigator.clipboard.writeText(source); showToast(message); }
  catch { showToast("Copy is unavailable in this browser."); }
}
elements["copy-button"].addEventListener("click", () => copySource(generated, mode === "fbs-json" ? "Schema JSON copied" : "Generated Zig copied"));
elements["copy-usage"].addEventListener("click", () => copySource(usage, "Usage example copied"));
elements["download-button"].addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([generated], { type: mode === "fbs-json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${outputStem()}.${mode === "fbs-json" ? "json" : "zig"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2500);
}
async function start() {
  updateMotion();
  try {
    await Promise.all([
      WebAssembly.instantiateStreaming(fetch(new URL("./runtime.wasm?v=comptime-buffers-1", import.meta.url)), {})
        .then(module => { engine = module.instance.exports; }).catch(() => { engine = null; }),
      loadExamples().then(manifest => {
        catalog = manifest.schemas;
        elements["example-select"].replaceChildren(...catalog.map((example, index) =>
          new Option(`${index + 1}. ${example.title}`, example.key)));
        selected = catalog.findIndex(example => example.runtime?.id === 1);
        const requested = new URL(location.href).searchParams.get("example");
        if (requested) selected = catalog.findIndex(example => example.key === requested);
        if (selected < 0) selected = 0;
        showOfficialExamples(manifest.programs);
      }),
    ]);
    loaded = true;
    for (const tab of tabs) tab.disabled = false;
    elements["schema-editor"].disabled = false;
    elements["reset-button"].disabled = false;
    for (const name of ["example-select", "previous-example", "next-example"]) elements[name].disabled = false;
    chooseExample(selected);
  } catch (failure) { showError(`The playground could not start: ${failure.message}`); }
}
function showOfficialExamples(programs) {
  const container = byId("official-programs");
  for (const program of programs) {
    const card = document.createElement("article");
    const encodePath = value => value.split("/").map(encodeURIComponent).join("/");
    card.innerHTML = `<h3>${escapeHtml(program.title)}</h3><p>${escapeHtml(program.description)}</p>
      <nav aria-label="${escapeHtml(program.title)} source"><a href="examples/?program=${encodeURIComponent(program.key)}">Read source →</a>${program.files.map(filename =>
        `<a href="examples/programs/${encodePath(program.key)}/${encodePath(filename)}" download>${escapeHtml(filename)}</a>`).join("")}
        <a href="https://github.com/neudinger/flatzz/tree/main/example/${encodePath(program.key)}">View project ↗</a></nav>`;
    for (const key of program.schemas) {
      const index = catalog.findIndex(example => example.key === key);
      if (index < 0) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Open ${catalog[index].title} schema`;
      button.addEventListener("click", () => {
        chooseExample(index);
        byId("playground").scrollIntoView({ block: "start" });
        elements["example-select"].focus({ preventScroll: true });
      });
      card.append(button);
    }
    container.append(card);
  }
}
start();
