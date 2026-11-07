import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { argTypes, mcpPage } from "../scripts/docs.ts";

// The website's MCP pages, and the tools' argument types, are made from src/mcp-tools.ts by `npm run docs`.
test("the website's MCP reference is up to date with the tool definitions", () => {
  const docs = (name) => readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8");
  assert.equal(docs("mcp.html"), mcpPage(), "docs/mcp.html is stale: run npm run docs");
});

test("the tools' argument types are up to date with their inputSchemas", () => {
  const types = readFileSync(new URL("../src/mcp-args.ts", import.meta.url), "utf8");
  assert.equal(types, argTypes(), "src/mcp-args.ts is stale: run npm run docs");
});
