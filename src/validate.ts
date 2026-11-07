// Checks JSON against a JSON Schema with @cfworker/json-schema: the MCP tools' arguments against their
// inputSchema (see mcp.ts), and what Cade's own buttons and forms carry when they come back (see
// payloads.ts), and cade.config.json (config-schema.ts). The first problem is given as a sentence for whoever sent it, in the tools' own words
// ("limit is a whole number from 1 to 100", "Give task_id.", "stauts isn't something this takes"), or
// null when there is none. An object takes only the properties it lists when its schema says
// additionalProperties: false (see strict in mcp-tools.ts).
import { Validator, type OutputUnit, type Schema as ValidatorSchema } from "@cfworker/json-schema";

// A JSON Schema, with the keywords Cade's schemas use: the tools' (mcp-tools.ts) and the payloads'
// (payloads.ts).
export interface Schema {
  type?: string | string[];
  description?: string;
  enum?: readonly unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  // false: no other properties; a schema: what each other property is.
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: Schema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  // A regular expression the text must match; `description` then says what is expected.
  pattern?: string;
}

// One Validator per schema, made the first time it is used.
const validators = new WeakMap<Schema, Validator>();

export function validate(schema: Schema, value: unknown): string | null {
  let validator = validators.get(schema);
  if (!validator) validators.set(schema, (validator = new Validator(schema as ValidatorSchema, "2020-12", true)));
  const { valid, errors } = validator.validate(value);
  return valid ? null : explain(schema, errors, value);
}

// The error to tell, of those the validator gives (an outer one, such as "properties", comes with the
// inner one that caused it): a missing argument first, then an unknown one, then the first other.
function explain(root: Schema, errors: OutputUnit[], value: unknown) {
  const own = errors.filter((error) => !error.keywordLocation.includes("/anyOf/") && !["properties", "items", "false"].includes(error.keyword));
  const error =
    own.find((one) => one.keyword === "required") ??
    own.find((one) => one.keyword === "additionalProperties") ??
    own.find((one) => one.keyword === "anyOf") ??
    own[0] ??
    errors[0]!;
  const schema = at(root, parts(error.keywordLocation).slice(0, -1));
  const path = pathOf(error.instanceLocation);
  const named = (key: string) => (path ? `${path}.${key}` : key);
  const quoted = /"([^"]+)"/.exec(error.error)?.[1] ?? "";
  switch (error.keyword) {
    case "required":
      return `Give ${named(quoted)}.`;
    case "additionalProperties": {
      const known = Object.keys(schema.properties ?? {}).map(named);
      return `${named(quoted)} isn't something this takes${known.length ? `; it takes ${known.join(", ")}` : ""}.`;
    }
    case "anyOf":
      // The error is from this schema's anyOf, so it has one.
      return `Give ${schema.anyOf!.map((option: Schema) => (option.required ?? []).map(named).join(" and ")).join(" or ")}.`;
    case "maxLength":
      return `${path} is ${[...String(valueAt(value, error))].length} characters; keep it to ${schema.maxLength} or fewer.`;
    case "pattern":
      return `${path || "The value"} ${JSON.stringify(valueAt(value, error))} isn't ${schema.description ?? "in the right form"}.`;
    case "maxItems":
      return `${path} has ${(valueAt(value, error) as unknown[]).length} entries; give at most ${schema.maxItems}.`;
    default: {
      // An item of a list of choices is told as the list.
      const item = /^(.*)\[\d+\]$/.exec(path);
      const parent = item && at(root, parts(error.keywordLocation).slice(0, -2));
      if (item && parent?.enum === undefined && schema.enum) return `${item[1]} is a list of: ${shown(schema.enum)}.`;
      return what(schema, path || "The arguments");
    }
  }
}

// A JSON pointer ("#/prs/add") as its parts.
function parts(location: string) {
  return location
    .split("/")
    .slice(1)
    .map((part) => decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~"));
}

// What is at `path` (a pointer's parts) in JSON: a schema or a value.
function dig(node: unknown, path: string[]): unknown {
  return path.reduce<unknown>((inner, part) => (inner as Record<string, unknown> | undefined)?.[part], node);
}

// The schema at `path` in `root`, or {} if there is none.
const at = (root: Schema, path: string[]): Schema => (dig(root, path) ?? {}) as Schema;

// The part of the value an error is about.
const valueAt = (value: unknown, error: OutputUnit) => dig(value, parts(error.instanceLocation));

// "#/prs/add" as prs.add, "#/fields/0" as fields[0].
function pathOf(location: string) {
  return parts(location).reduce((path, part) => (/^\d+$/.test(part) ? `${path}[${part}]` : path ? `${path}.${part}` : part), "");
}

// What a value of `schema` is, in the tools' words.
function what(schema: Schema, name: string) {
  if (schema.enum) return `${name} is one of ${shown(schema.enum)}.`;
  const types: string[] = [schema.type ?? []].flat();
  const nullable = types.includes("null") ? ", or null" : "";
  switch (types.find((type) => type !== "null")) {
    case "integer":
    case "number": {
      const { minimum: min, maximum: max } = schema;
      const range = min !== undefined && max !== undefined ? ` from ${min} to ${max}` : min !== undefined ? ` of at least ${min}` : max !== undefined ? ` of at most ${max}` : "";
      return `${name} is ${types.includes("integer") ? "a whole number" : "a number"}${range}${nullable}.`;
    }
    case "string":
      return `${name} is text${nullable}.`;
    case "boolean":
      return `${name} is true or false${nullable}.`;
    case "array":
      return schema.items?.enum ? `${name} is a list of: ${shown(schema.items.enum)}.` : `${name} is a list${nullable}.`;
    case "object":
      return `${name} is an object${nullable}.`;
    default:
      return `${name} isn't valid.`;
  }
}

const shown = (values: readonly unknown[]) => values.filter((value) => value !== null).join(", ");
