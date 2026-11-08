import { rocketFields, rocketLayout, rocketPartAt } from "./rocket-model.js?v=official-examples-1";

const accents = ["#ff8c79", "#f9b55a", "#b9ddd9", "#f3d394"];

/** Interactive counterpart of Zast's AstTree: canvas geometry plus native field buttons. */
export class SchemaRocket {
  constructor(container) {
    this.container = container;
    this.canvas = container.querySelector("canvas");
    this.context = this.canvas.getContext("2d");
    this.stage = container.querySelector(".rocket-stage");
    this.labels = container.querySelector(".rocket-labels");
    this.path = container.querySelector(".rocket-path");
    this.detail = container.querySelector(".rocket-detail");
    this.caption = container.querySelector(".rocket-caption");
    this.toggle = container.querySelector(".rocket-toggle");
    this.fields = [];
    this.selected = "root";
    this.hovered = null;
    this.expanded = true;
    this.separation = 1;
    this.frame = null;
    this.visible = true;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.motion = !this.reduced.matches;
    this.pilot = new Image();
    this.pilot.onload = () => this.draw(performance.now());
    this.pilot.src = new URL("./rocket-ziguana.png", import.meta.url).href;
    this.toggle.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.toggle.textContent = this.expanded ? "Assemble rocket" : "Separate stages";
      this.toggle.setAttribute("aria-pressed", String(this.expanded));
      this.schedule();
    });
    this.labels.addEventListener("click", event => {
      const button = event.target.closest("[data-rocket-part]");
      if (button) this.select(button.dataset.rocketPart, { reveal: true });
    });
    this.labels.addEventListener("focusin", event => {
      if (event.target.dataset.rocketPart) this.select(event.target.dataset.rocketPart);
    });
    this.labels.addEventListener("pointerover", event => this.preview(event.target.closest("[data-rocket-part]")?.dataset.rocketPart ?? null));
    this.labels.addEventListener("pointerleave", () => this.preview(null));
    this.labels.addEventListener("keydown", event => this.navigate(event));
    this.path.addEventListener("click", event => {
      if (event.target.dataset.rocketPart) this.select(event.target.dataset.rocketPart, { reveal: true });
    });
    this.canvas.addEventListener("pointermove", event => {
      const part = this.partAt(event);
      this.canvas.style.cursor = part === null ? "default" : "pointer";
      this.preview(part);
    });
    this.canvas.addEventListener("pointerleave", () => this.preview(null));
    this.canvas.addEventListener("click", event => {
      const part = this.partAt(event);
      if (part !== null) this.select(part, { reveal: true });
    });
    this.reduced.addEventListener("change", () => this.schedule());
    document.addEventListener("visibilitychange", () => this.schedule());
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.stage);
    this.visibility = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.schedule();
    });
    this.visibility.observe(this.stage);
    this.resize();
  }

  update(report, root) {
    const previous = this.selected;
    this.report = report;
    this.root = root;
    this.fields = rocketFields(report);
    this.selected = this.fields.some(field => field.name === previous) ? previous
      : this.fields.find(field => field.borrowed)?.name || "root";
    this.stage.style.height = this.fields.length > 4
      ? `${198 + this.fields.length * 52 + (this.fields.length - 1) * 13}px` : "";
    this.hovered = null;
    this.labels.replaceChildren();
    for (const [name, title, subtitle] of [
      ["root", root, "root table"],
      ...this.fields.map(field => [field.name, field.name, `${field.wire_type} · ${field.value}`]),
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.rocketPart = name;
      button.setAttribute("aria-label", name === "root" ? `Select ${root} root table` : `Select ${name} rocket stage`);
      const label = document.createElement("span");
      label.textContent = title;
      const note = document.createElement("small");
      note.textContent = subtitle;
      button.append(label, note);
      this.labels.append(button);
    }
    this.caption.textContent = `${this.fields.length} field stages · ${report.schema_only ? "live schema" : `${report.length} B frame`}`;
    containerSummary(this.container, `${root}: ${this.fields.length} schema fields represented by rocket stages. Select a stage or its label to highlight both source panels. ${report.schema_only ? "Schema declarations; no serialized frame." : "Byte locations come from the real serialized frame."} Use up and down arrow keys to move between stages.`);
    this.resize();
    this.showSelection();
    this.schedule();
  }

  fail(message) {
    this.report = null;
    this.stage.style.height = "";
    this.fields = [];
    this.labels.replaceChildren();
    this.path.replaceChildren();
    this.detail.textContent = message;
    this.caption.textContent = "Rocket unavailable";
    this.schedule();
  }

  select(name, { reveal = false } = {}) {
    if (name !== "root" && !this.fields.some(field => field.name === name)) return;
    this.selected = name;
    this.hovered = null;
    this.showSelection(reveal);
    const control = [...this.labels.children].find(button => button.dataset.rocketPart === name);
    const viewport = this.stage.parentElement;
    if (control && this.stage.offsetHeight > viewport.clientHeight) {
      const top = parseFloat(control.style.top);
      if (top < viewport.scrollTop || top + 40 > viewport.scrollTop + viewport.clientHeight)
        viewport.scrollTop = top - viewport.clientHeight / 2;
    }
    this.schedule();
  }

  preview(name) {
    if (this.hovered === name) return;
    this.hovered = name;
    this.showSelection();
    this.draw(performance.now());
  }

  showSelection(reveal = false) {
    if (!this.report) return;
    const focusedPath = this.path.contains(document.activeElement)
      ? document.activeElement.dataset.rocketPart : null;
    const name = this.hovered ?? this.selected;
    const field = this.fields.find(candidate => candidate.name === name);
    for (const button of this.labels.children) {
      button.classList.toggle("selected", button.dataset.rocketPart === name);
      button.setAttribute("aria-pressed", String(button.dataset.rocketPart === this.selected));
    }
    this.path.replaceChildren();
    for (const [part, label] of [["root", this.root], ...(field ? [[field.name, field.name]] : [])]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.rocketPart = part;
      button.textContent = label;
      if (part === name) button.setAttribute("aria-current", "true");
      this.path.append(button);
    }
    if (focusedPath) this.path.querySelector(`[data-rocket-part="${focusedPath}"]`)?.focus({ preventScroll: true });
    this.detail.textContent = field ? this.report.schema_only
      ? `${field.zigType} · ${field.location} · ${field.access}`
      : `${field.zigType} = ${field.value} · ${field.location} · ${field.access}`
      : this.report.schema_only ? `${this.root} · ${this.fields.length} fields · no serialized frame`
        : `table +${this.report.table_start} · vtable +${this.report.vtable_start} · ${this.report.fields.length} fields`;
    this.container.dispatchEvent(new CustomEvent("rocket-field", {
      bubbles: true, detail: { name: field?.name ?? null, root: this.root, reveal },
    }));
  }

  navigate(event) {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const controls = [...this.labels.children];
    const index = controls.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const target = event.key === "Home" || event.key === "ArrowLeft" ? 0
      : event.key === "End" ? controls.length - 1
        : Math.max(0, Math.min(controls.length - 1, index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1)));
    controls[target].focus({ preventScroll: true });
  }

  partAt(event) {
    if (!this.report) return null;
    const bounds = this.canvas.getBoundingClientRect();
    const part = rocketPartAt(this.layout, event.clientX - bounds.left, event.clientY - bounds.top);
    return typeof part === "number" ? this.fields[part].name : part;
  }

  resize() {
    const { width, height } = this.stage.getBoundingClientRect();
    this.width = width;
    this.height = height;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.placeLabels();
    this.draw(performance.now());
  }

  placeLabels() {
    this.layout = rocketLayout(this.fields.length, this.width, this.height, this.separation);
    const { nose, center, labelWidth } = this.layout;
    [...this.labels.children].forEach((button, index) => {
      const label = index ? this.layout.stages[index - 1].label
        : { x: center + this.layout.radius + 24, y: nose.y + 29, width: labelWidth };
      button.style.left = `${label.x}px`;
      button.style.top = `${label.y}px`;
      button.style.width = `${label.width}px`;
      button.style.setProperty("--stage-color", index ? accents[(index - 1) % accents.length] : "#ffaf90");
    });
  }

  setMotion(enabled) {
    this.motion = enabled;
    this.schedule();
  }

  schedule() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    const animate = this.report && this.motion && !this.reduced.matches && this.visible && !document.hidden;
    if (animate) this.frame = requestAnimationFrame(time => this.animate(time));
    else {
      this.separation = Number(this.expanded);
      this.placeLabels();
      this.draw(0);
    }
  }

  animate(time) {
    this.frame = null;
    this.separation += (Number(this.expanded) - this.separation) * .13;
    if (Math.abs(this.separation - Number(this.expanded)) > .001) this.placeLabels();
    this.draw(time);
    this.frame = requestAnimationFrame(next => this.animate(next));
  }

  draw(time = 0) {
    const ctx = this.context;
    if (!ctx || !this.width || !this.height) return;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.report) return;
    const { center: x, radius: r, nose, stages, engine } = this.layout;
    const active = this.hovered ?? this.selected;
    const live = this.motion && !this.reduced.matches && this.visible && !document.hidden;
    const pulse = live ? Math.sin(time * .004) : 0;

    // A quiet launch grid and guide spine keep detached sections visibly related.
    ctx.strokeStyle = "#ff987610";
    ctx.lineWidth = 1;
    for (let row = 26; row < this.height; row += 36) {
      ctx.beginPath(); ctx.moveTo(x - 95, row); ctx.lineTo(x + 95, row); ctx.stroke();
    }
    ctx.setLineDash([2, 6]);
    ctx.strokeStyle = "#e3935a50";
    ctx.beginPath(); ctx.moveTo(x, nose.y + 30); ctx.lineTo(x, engine.y + 35); ctx.stroke();
    ctx.setLineDash([]);

    // Fins and nozzle are structural, while the nose selects the actual root table.
    ctx.fillStyle = "#9d3637";
    ctx.strokeStyle = "#e56c5d";
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(x + side * r * .8, engine.y - 38);
      ctx.bezierCurveTo(x + side * r * 1.6, engine.y - 21, x + side * r * 1.7, engine.y + 25, x + side * r * 1.6, engine.y + 34);
      ctx.lineTo(x + side * r * .7, engine.y + 11); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    const flame = ctx.createLinearGradient(x, engine.y + 20, x, engine.y + 72);
    flame.addColorStop(0, "#fff0ad"); flame.addColorStop(.35, "#ffad4c"); flame.addColorStop(1, "#f0502800");
    ctx.fillStyle = flame;
    ctx.beginPath(); ctx.moveTo(x - r * .43, engine.y + 20);
    ctx.bezierCurveTo(x - r * .55, engine.y + 42, x - r * .15, engine.y + 49, x, engine.y + 65 + pulse * 5);
    ctx.bezierCurveTo(x + r * .15, engine.y + 49, x + r * .55, engine.y + 42, x + r * .43, engine.y + 20);
    ctx.closePath(); ctx.fill();
    const nozzle = ctx.createLinearGradient(x - r, 0, x + r, 0);
    nozzle.addColorStop(0, "#242a30"); nozzle.addColorStop(.45, "#9e9a8e"); nozzle.addColorStop(1, "#1b2027");
    ctx.fillStyle = nozzle; ctx.strokeStyle = "#a8987b";
    ctx.beginPath(); ctx.moveTo(x - r * .58, engine.y); ctx.lineTo(x + r * .58, engine.y);
    ctx.lineTo(x + r * .72, engine.y + 23); ctx.lineTo(x - r * .72, engine.y + 23); ctx.closePath(); ctx.fill(); ctx.stroke();

    const shell = ctx.createLinearGradient(x - r, 0, x + r, 0);
    shell.addColorStop(0, "#662b30"); shell.addColorStop(.35, "#f27567"); shell.addColorStop(.6, "#c84744"); shell.addColorStop(1, "#58262d");
    ctx.fillStyle = shell; ctx.strokeStyle = active === "root" ? "#ffc78d" : "#ed897578";
    ctx.lineWidth = active === "root" ? 2 : 1;
    ctx.beginPath(); ctx.moveTo(x, nose.y);
    ctx.bezierCurveTo(x + r * .8, nose.y + 20, x + r, nose.y + 50, x + r, nose.y + 90);
    ctx.lineTo(x - r, nose.y + 90);
    ctx.bezierCurveTo(x - r, nose.y + 50, x - r * .8, nose.y + 20, x, nose.y);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    const windowY = nose.y + 63;
    ctx.save(); ctx.beginPath(); ctx.ellipse(x, windowY, r * .56, r * .56, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = "#202c32"; ctx.fillRect(x - r, windowY - r, r * 2, r * 2);
    if (this.pilot.complete && this.pilot.naturalWidth) ctx.drawImage(this.pilot, 786, 225, 310, 350, x - r * .6, windowY - r * .62, r * 1.2, r * 1.36);
    ctx.restore();
    ctx.strokeStyle = "#f6b277"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, windowY, r * .58, r * .58, 0, 0, Math.PI * 2); ctx.stroke();

    stages.forEach((stage, index) => {
      const field = this.fields[index];
      const chosen = field.name === active;
      const accent = accents[index % accents.length];
      ctx.save();
      if (chosen) { ctx.shadowColor = accent; ctx.shadowBlur = 19; }
      ctx.fillStyle = shell; ctx.strokeStyle = chosen ? accent : "#ffb69b65"; ctx.lineWidth = chosen ? 2 : 1;
      ctx.beginPath(); ctx.roundRect(x - r, stage.y, r * 2, stage.height, 3); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#151e27c4"; ctx.fillRect(x - r + 1, stage.y + 7, r * 2 - 2, 5);
      ctx.fillStyle = chosen ? accent : "#f0d5bf";
      ctx.font = `${Math.max(9, r * .24)}px SFMono-Regular, Consolas, monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(index + 1).padStart(2, "0"), x, stage.y + stage.height * .62);
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(x - r + 10, stage.y + stage.height - 9, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      this.drawLeader(stage.label, x + (stage.label.right ? r : -r), stage.y + stage.height / 2, chosen ? accent : "#ae8f8265");
    });
    const rootButton = this.labels.firstElementChild;
    if (rootButton) this.drawLeader({ x: parseFloat(rootButton.style.left), y: parseFloat(rootButton.style.top), width: parseFloat(rootButton.style.width), right: true }, x + r * .8, nose.y + 46, active === "root" ? "#ffaf90" : "#ae8f8265");
  }

  drawLeader(label, x, y, color) {
    const ctx = this.context;
    const end = label.right ? label.x - 5 : label.x + label.width + 5;
    ctx.lineWidth = 1; ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(end, label.y + 20); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
  }
}

function containerSummary(container, message) {
  container.querySelector(".rocket-summary").textContent = message;
}
