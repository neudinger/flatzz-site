/** Ignore obsolete edits and replace workers that fail or exceed their execution window. */
export class SchemaCompiler {
  constructor(onResult) {
    this.onResult = onResult;
    this.revision = 0;
    this.worker = null;
    this.timer = null;
    this.request = null;
  }

  invalidate() {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = null;
    this.request = null;
  }

  compile(request) {
    this.invalidate();
    const id = this.revision;
    if (!this.worker) {
      this.worker = new Worker(new URL("./compiler-worker.js?v=comptime-buffers-1", import.meta.url), { type: "module" });
      const worker = this.worker;
      this.worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (data.fatal) {
          worker.terminate();
          this.worker = null;
          if (data.id !== this.revision) {
            // A trap in an obsolete conversion still invalidates this instance.
            // Retry only the latest pending request, preserving the user's current mode.
            if (this.request) this.compile(this.request);
            return;
          }
        }
        if (data.id !== this.revision) return;
        clearTimeout(this.timer);
        this.timer = null;
        const current = this.request;
        this.request = null;
        this.onResult({ ...data, request: current });
      };
      this.worker.onerror = event => {
        event.preventDefault();
        if (this.worker !== worker) return;
        clearTimeout(this.timer);
        worker.terminate();
        this.worker = null;
        this.timer = null;
        const current = this.request;
        this.request = null;
        if (current) this.onResult({ error: "The schema compiler could not load. Edit or import again to retry.", request: current });
      };
    }
    this.request = request;
    this.worker.postMessage({ id, request });
    this.timer = setTimeout(() => {
      if (id !== this.revision) return;
      this.worker.terminate();
      this.worker = null;
      this.timer = null;
      this.request = null;
      this.onResult({ error: "Compilation exceeded the browser time limit. Reduce the schema and try again.", request });
    }, 6000);
  }
}
