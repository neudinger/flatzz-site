import { highlight } from "./highlight.js?v=library-content-1";

const reference = document.querySelector(".api-reference");
const viewer = document.querySelector(".compiler-reference");
let frame;
let toastTimer;
function enhance() {
  const symbol = location.hash.slice(1).split("?")[0];
  document.title = (symbol || document.querySelector(".reference-intro h1").textContent)
    + " — flatzz API";
  for (const link of document.querySelectorAll(".reference-sidebar > nav:first-child a")) {
    if (new URL(link.href).pathname === location.pathname) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const code of viewer.querySelectorAll("pre > code")) {
    if (code.id === "sourceLineNumbers") continue;
    if (!code.childElementCount && code.closest("#tldDocs, .fieldDocs, #listFns dd, #listParams")
        && /^\s*(?:pub |const |var |fn |test |try |defer )/m.test(code.textContent))
      code.innerHTML = highlight(code.textContent);
    const pre = code.parentElement;
    if (pre.querySelector(".reference-copy")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reference-copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", "Copy code");
    button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code.textContent); button.textContent = "Copied"; }
      catch {
        const toast = document.getElementById("toast");
        toast.textContent = "Clipboard unavailable. Select the code to copy it.";
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
      }
    });
    pre.append(button);
  }
  const outline = document.getElementById("reference-outline");
  const fragment = document.createDocumentFragment();
  for (const section of viewer.querySelectorAll("section > div[id^='sect']:not(.hidden)")) {
    const heading = section.querySelector("h2");
    if (!heading) continue;
    const link = document.createElement("a");
    link.href = location.href;
    link.textContent = heading.textContent;
    // The compiler owns hash routing. Section jumps preserve the current symbol URL.
    link.addEventListener("click", event => { event.preventDefault(); heading.scrollIntoView(); });
    fragment.append(link);
  }
  outline.replaceChildren(fragment);
}
new MutationObserver(() => {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = null; enhance(); });
}).observe(viewer, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
document.getElementById("reference-size").addEventListener("change", event =>
  reference.style.setProperty("--reference-code-size", event.target.value + "px"));
document.getElementById("reference-wrap").addEventListener("change", event =>
  reference.classList.toggle("wrap-code", event.target.checked));
enhance();
