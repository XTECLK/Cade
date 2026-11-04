import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { indexPage, mcpPage } from "../scripts/docs.mjs";

// The website's MCP pages are made from src/mcp-tools.js by `npm run docs`.
test("the website's MCP reference and tool list are up to date with the tool definitions", () => {
  const docs = (name) => readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8");
  assert.equal(docs("mcp.html"), mcpPage(), "docs/mcp.html is stale: run npm run docs");
  assert.equal(docs("index.html"), indexPage(docs("index.html")), "docs/index.html is stale: run npm run docs");
});
