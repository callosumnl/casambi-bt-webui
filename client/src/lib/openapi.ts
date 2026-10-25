/** Helpers that turn the server's OpenAPI document into what the API documentation page shows. */
type Schema = Record<string, unknown>;
export type OpenApiDocument = {
  info: { title: string; version: string; description?: string };
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, RawOperation>>;
  components: { schemas: Record<string, Schema> };
};
type RawOperation = {
  tags?: string[]; summary?: string; description?: string; "x-required-role"?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>;
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
  responses: Record<string, { description: string; content?: Record<string, { schema: Schema }> }>;
};
export type DocOperation = {
  key: string; method: string; path: string; tag: string; summary: string; description: string; role: string;
  parameters: NonNullable<RawOperation["parameters"]>; body: Schema | null; bodyRequired: boolean;
  responses: Array<{ status: string; description: string; schema: string | null }>;
};

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];
const refName = (schema: Schema | undefined) => typeof schema?.$ref === "string" ? schema.$ref.split("/").pop()! : null;

/** Operations grouped by tag, in the document's tag order. */
export function groupOperations(document: OpenApiDocument): Array<{ tag: string; description: string; operations: DocOperation[] }> {
  const operations: DocOperation[] = Object.entries(document.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, raw]) => ({
    key: `${method} ${path}`, method, path, tag: raw.tags?.[0] ?? "Other", summary: raw.summary ?? "", description: raw.description ?? "", role: raw["x-required-role"] ?? "user",
    parameters: raw.parameters ?? [], body: raw.requestBody?.content["application/json"]?.schema ?? null, bodyRequired: raw.requestBody?.required ?? false,
    responses: Object.entries(raw.responses).map(([status, response]) => {
      const schema = Object.values(response.content ?? {})[0]?.schema;
      const items = schema?.type === "array" ? refName(schema.items as Schema) : null;
      return { status, description: response.description, schema: refName(schema) ?? (items ? `${items}[]` : null) };
    }),
  })));
  const tags = [...(document.tags ?? []).map(tag => tag.name), ...operations.map(operation => operation.tag)].filter((tag, index, all) => all.indexOf(tag) === index);
  return tags.map(tag => ({
    tag, description: document.tags?.find(candidate => candidate.name === tag)?.description ?? "",
    operations: operations.filter(operation => operation.tag === tag).sort((a, b) => a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)),
  })).filter(group => group.operations.length > 0);
}

/** Follows a `$ref` into `components.schemas`. */
export function resolve(schema: Schema, document: OpenApiDocument): Schema {
  const name = refName(schema);
  return name ? document.components.schemas[name] ?? schema : schema;
}

/** A small, valid-looking example value: required properties only, first enum value, non-null first. */
export function exampleFromSchema(input: Schema, document: OpenApiDocument, depth = 0): unknown {
  const schema = resolve(input, document);
  if (depth > 6) return null;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const options = (schema.anyOf ?? schema.oneOf) as Schema[];
    return exampleFromSchema(options.find(option => option.type !== "null") ?? options[0], document, depth + 1);
  }
  if (Array.isArray(schema.allOf)) return Object.assign({}, ...(schema.allOf as Schema[]).map(part => exampleFromSchema(part, document, depth + 1)));
  if ("default" in schema) return schema.default;
  switch (schema.type) {
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = new Set((schema.required ?? []) as string[]);
      return Object.fromEntries(Object.entries(properties).filter(([name]) => required.has(name)).map(([name, property]) => [name, exampleFromSchema(property, document, depth + 1)]));
    }
    case "array": return [];
    case "integer": case "number": return typeof schema.minimum === "number" && schema.minimum > 0 ? schema.minimum : 1;
    case "boolean": return true;
    case "string": return schema.format === "date" ? "2026-12-24" : schema.format === "date-time" ? "2026-12-24T18:00:00.000Z" : "text";
    default: return null;
  }
}

/** A copy-paste curl command for an operation, authenticated with an API key from $CASAMBI_API_KEY. */
export function curlExample(operation: DocOperation, document: OpenApiDocument, baseUrl: string): string {
  const path = operation.path.replace("{id}", "1");
  const lines = [`curl -sS -X ${operation.method.toUpperCase()} "${baseUrl}${path}"`];
  if (operation.role !== "public") lines.push(`  -H "X-API-Key: $CASAMBI_API_KEY"`);
  if (operation.body) lines.push(`  -H "Content-Type: application/json"`, `  -d '${JSON.stringify(exampleFromSchema(operation.body, document))}'`);
  return lines.join(" \\\n");
}
