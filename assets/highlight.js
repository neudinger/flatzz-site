export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
export function highlight(line) {
  const tokens = /\/\/[^\n]*|"(?:\\.|[^"\\])*"|\b(?:const|pub|var|fn|if|else|try|defer|test|return|null|true|false|undefined|struct|table|root_type|enum|union|namespace|u8|u32|f32|bool|float|uint|string)\b|-?\b\d+(?:\.\d+)?\b/g;
  let result = "", position = 0;
  for (const match of line.matchAll(tokens)) {
    result += escapeHtml(line.slice(position, match.index));
    const token = match[0];
    const kind = token.startsWith("//") ? "comment" : token.startsWith('"') ? "string" : /^-?\d/.test(token) ? "number" : "keyword";
    result += `<span class="syntax-${kind}">${escapeHtml(token)}</span>`;
    position = match.index + token.length;
  }
  return result + escapeHtml(line.slice(position));
}
