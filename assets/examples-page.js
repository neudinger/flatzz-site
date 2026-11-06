import { escapeHtml, highlight } from "./highlight.js?v=library-content-1";

const encodePath = value => value.split("/").map(encodeURIComponent).join("/");
const byId = identifier => document.getElementById(identifier);
let catalogue;
let source = "";
let revision = 0;
async function load(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Unable to load official example source.");
  return response.text();
}
function selection() {
  const parameters = new URL(location.href).searchParams;
  const key = parameters.get("program");
  const program = catalogue.programs.find(item => item.key === key)
    || (!key ? catalogue.programs.find(item => item.key === "readme") || catalogue.programs[0] : null);
  if (!program) throw new Error("Unknown official example project.");
  const filename = parameters.get("file") || "main.zig";
  if (!program.files.includes(filename)) throw new Error("Unknown official example file.");
  return { program, filename };
}
function href(program, filename = "main.zig") {
  return `?program=${encodeURIComponent(program.key)}&file=${encodeURIComponent(filename)}`;
}
async function render() {
  const current = ++revision;
  byId("program-copy").disabled = true;
  byId("program-download").hidden = true;
  byId("program-error").hidden = true;
  try {
    const { program, filename } = selection();
    byId("program-title").textContent = program.title;
    document.title = `${program.title} example — flatzz`;
    byId("program-description").textContent = program.description;
    byId("program-filename").textContent = filename;
    byId("program-code").textContent = "Loading source…";
    byId("program-navigation").innerHTML = catalogue.programs.map(item =>
      `<a href="${href(item)}"${item.key === program.key ? ' aria-current="page"' : ""}>${escapeHtml(item.title)}</a>`).join("");
    byId("program-files").innerHTML = program.files.map(name =>
      `<a href="${href(program, name)}"${name === filename ? ' aria-current="page"' : ""}>${escapeHtml(name)}</a>`).join("");
    byId("program-schemas").innerHTML = program.schemas.map(key => {
      const schema = catalogue.schemas.find(item => item.key === key);
      return `<a href="../?example=${encodeURIComponent(key)}#playground">Open ${escapeHtml(schema.title)} in playground →</a>`;
    }).join("") + `<a href="https://github.com/neudinger/flatzz/tree/main/example/${encodePath(program.key)}">View project on GitHub ↗</a>`;
    const url = `programs/${encodePath(program.key)}/${encodePath(filename)}`;
    const text = await load(url);
    if (current !== revision) return;
    source = text;
    byId("program-code").innerHTML = /\.(zig|zon|fbs)$/.test(filename) ? highlight(text) : escapeHtml(text);
    byId("program-copy").disabled = false;
    byId("program-copy").textContent = "Copy";
    byId("program-download").href = url;
    byId("program-download").hidden = false;
  } catch (error) {
    if (current !== revision) return;
    byId("program-code").textContent = "Source unavailable.";
    byId("program-error").textContent = error.message;
    byId("program-error").hidden = false;
  }
}
byId("program-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(source); byId("program-copy").textContent = "Copied"; }
  catch { byId("program-error").textContent = "Clipboard unavailable. Select the source to copy it."; byId("program-error").hidden = false; }
});
for (const identifier of ["program-navigation", "program-files"]) byId(identifier).addEventListener("click", event => {
  const link = event.target.closest("a");
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
  event.preventDefault();
  history.pushState(null, "", link.href);
  render();
});
window.addEventListener("popstate", () => { if (catalogue) render(); });
try { catalogue = JSON.parse(await load("catalog.json")); await render(); }
catch (error) { byId("program-error").textContent = error.message; byId("program-error").hidden = false; }
