// A small JSON Schema check for the MCP tests: the keywords Cade's tool schemas use (type,
// enum, properties, required, additionalProperties, items, minimum, maximum). It returns the
// problems found, as "path: what's wrong", or an empty list.
export function check(schema, value, path = "result") {
  const types = [schema.type].flat().filter(Boolean);
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const fits = (type) => type === kind || (type === "number" && kind === "integer");
  if (types.length && !types.some(fits)) return [`${path}: expected ${types.join(" or ")}, got ${kind}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`];
  const problems = [];
  if (kind === "integer" || kind === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path}: above ${schema.maximum}`);
  }
  if (kind === "array" && schema.items) value.forEach((item, i) => problems.push(...check(schema.items, item, `${path}[${i}]`)));
  if (kind === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${path}.${key}: missing`);
    for (const [key, item] of Object.entries(value)) {
      const known = schema.properties?.[key];
      if (known) problems.push(...check(known, item, `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}.${key}: not in the schema`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") problems.push(...check(schema.additionalProperties, item, `${path}.${key}`));
    }
  }
  return problems;
}
