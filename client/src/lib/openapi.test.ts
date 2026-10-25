import { describe, expect, it } from "vitest";
import { curlExample, exampleFromSchema, groupOperations, OpenApiDocument } from "./openapi";

const document: OpenApiDocument = {
  info: { title: "Test", version: "1" },
  tags: [{ name: "Control", description: "Switch lamps." }, { name: "System" }],
  components: { schemas: {
    ControlRequest: { type: "object", properties: { targetType: { type: "string", enum: ["unit", "group"] }, targetId: { anyOf: [{ type: "null" }, { type: "integer", minimum: 0 }] }, value: {}, fade: { type: "integer" } }, required: ["targetType", "targetId"] },
    Snapshot: { type: "object", properties: { connected: { type: "boolean" } }, required: ["connected"] },
    Health: { type: "object", properties: { status: { type: "string", const: "ok" } }, required: ["status"] },
  } },
  paths: {
    "/health": { get: { tags: ["System"], summary: "Health", "x-required-role": "public", responses: { 200: { description: "Up", content: { "application/json": { schema: { $ref: "#/components/schemas/Health" } } } } } } },
    "/control": { post: { tags: ["Control"], summary: "Control", "x-required-role": "user", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ControlRequest" } } } }, responses: { 200: { description: "After", content: { "application/json": { schema: { $ref: "#/components/schemas/Snapshot" } } } }, 422: { description: "Invalid" } } } },
    "/devices/{id}/on": { post: { tags: ["Control"], summary: "On", "x-required-role": "user", responses: { 200: { description: "After", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Snapshot" } } } } } } } },
  },
};

describe("API documentation helpers", () => {
  it("groups operations by tag in document order, with response schema names", () => {
    const groups = groupOperations(document);
    expect(groups.map(group => [group.tag, group.description, group.operations.map(operation => operation.key)])).toEqual([
      ["Control", "Switch lamps.", ["post /control", "post /devices/{id}/on"]],
      ["System", "", ["get /health"]],
    ]);
    expect(groups[0].operations[0]).toMatchObject({ role: "user", bodyRequired: true, responses: [{ status: "200", schema: "Snapshot" }, { status: "422", schema: null }] });
    expect(groups[0].operations[1].responses[0].schema).toBe("Snapshot[]");
  });

  it("builds a minimal example from required properties, enums, and non-null alternatives", () => {
    expect(exampleFromSchema({ $ref: "#/components/schemas/ControlRequest" }, document)).toEqual({ targetType: "unit", targetId: 1 });
    expect(exampleFromSchema({ $ref: "#/components/schemas/Health" }, document)).toEqual({ status: "ok" });
    expect(exampleFromSchema({ type: "object", examples: [{ targetType: "group", targetId: 2 }] }, document)).toEqual({ targetType: "group", targetId: 2 });
  });

  it("writes a curl command with the API key header only where it is needed", () => {
    const [control, system] = groupOperations(document);
    expect(curlExample(control.operations[0], document, "http://pi.local:3000/api/v1")).toBe([
      'curl -sS -X POST "http://pi.local:3000/api/v1/control"',
      '  -H "X-API-Key: $CASAMBI_API_KEY"',
      '  -H "Content-Type: application/json"',
      `  -d '{"targetType":"unit","targetId":1}'`,
    ].join(" \\\n"));
    expect(curlExample(control.operations[1], document, "/api/v1")).toContain('"/api/v1/devices/1/on"');
    expect(curlExample(system.operations[0], document, "/api/v1")).not.toContain("X-API-Key");
  });
});
