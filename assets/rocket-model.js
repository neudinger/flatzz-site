const zigTypes = { uint: "u32", float: "f32", string: "?[]const u8", "[ubyte]": "?[]const u8", bool: "bool" };

/** Stages represent logical schema fields, not contiguous or proportionally sized wire regions. */
export function rocketFields(report) {
  return report.fields.map((field, index) => {
    if (report.schema_only) return {
      ...field, index, value: field.display, zigType: field.zig_type,
      location: `wire ID ${field.field_id} · no serialized frame`, access: "Schema declaration",
    };
    const value = field.wire_type === "string" ? JSON.stringify(field.display)
      : ["uint", "float"].includes(field.wire_type) ? String(Number(field.display)) : field.display;
    const absent = field.slot === null && ["null", "none"].includes(field.display);
    const location = field.slot === null ? `${absent ? "absent value" : "schema default"} · no stored slot`
      : field.payload !== null ? `slot +${field.slot} → payload +${field.payload} · ${field.payload_size} B`
        : `frame +${field.slot} · ${field.width} B${field.inline_value ? " · inline" : ""}`;
    return {
      ...field, index, value, zigType: field.zig_type || zigTypes[field.wire_type] || field.wire_type, location,
      access: field.slot === null ? absent ? "Absent value" : "Default value"
        : field.borrowed ? "Borrowed bytes" : "Scalar by value",
    };
  });
}

/** Keep the rocket and keyboard controls inside the measured canvas, including narrow screens. */
export function rocketLayout(count, width, height, separation = 1) {
  const radius = Math.max(26, Math.min(48, width * .095));
  const center = width * .5;
  const labelWidth = Math.max(72, Math.min(148, (width - radius * 2) / 2 - 26));
  const gap = separation * 13;
  const stageHeight = Math.min(52, (height - 198 - Math.max(0, count - 1) * gap) / Math.max(count, 1));
  const bodyHeight = count * stageHeight + Math.max(0, count - 1) * gap;
  const top = (height - (bodyHeight + 182)) / 2;
  const nose = { x: center, y: top, width: radius * 2, height: 90 };
  const bodyTop = top + nose.height + 8;
  const stages = Array.from({ length: count }, (_, index) => {
    const y = bodyTop + index * (stageHeight + gap);
    const right = index % 2 === 0;
    return {
      index, x: center, y, width: radius * 2, height: stageHeight,
      label: { x: right ? width - labelWidth - 7 : 7, y: y + stageHeight / 2 - 20,
        width: labelWidth, height: 40, right },
    };
  });
  return { width, height, center, radius, labelWidth, nose, stages,
    engine: { x: center, y: bodyTop + bodyHeight + 5, width: radius * 1.5, height: 23 } };
}

export function rocketPartAt(layout, x, y) {
  if (Math.abs(x - layout.center) <= layout.radius && y >= layout.nose.y && y <= layout.nose.y + layout.nose.height) return "root";
  return layout.stages.find(stage => Math.abs(x - stage.x) <= stage.width / 2 + 6
    && y >= stage.y && y <= stage.y + stage.height)?.index ?? null;
}
