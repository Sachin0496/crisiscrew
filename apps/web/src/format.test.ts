import { describe, expect, it } from "vitest";
import { plural } from "./format";

describe("plural", () => {
  it("uses the singular for exactly one and the plural otherwise", () => {
    expect(plural(1, "ticket")).toBe("1 ticket");
    expect(plural(2, "ticket")).toBe("2 tickets");
    expect(plural(0, "ticket")).toBe("0 tickets");
  });

  it("takes an irregular plural", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(42, "entry", "entries")).toBe("42 entries");
  });
});

describe("root-cause source labels", () => {
  it("names the MCP servers that answered", async () => {
    const { sourceLabel } = await import("./components/incident/RootCause");
    expect(sourceLabel("sandbox")).toBe("Sandbox");
    expect(sourceLabel("mcp:k8s-prod")).toBe("MCP · k8s-prod");
    expect(sourceLabel("mcp:k8s-prod, mcp:cloudwatch")).toBe("MCP · k8s-prod, cloudwatch");
    expect(sourceLabel("mcp:k8s-prod+cloudwatch")).toBe("MCP · k8s-prod, cloudwatch");
    expect(sourceLabel("github")).toBe("Live");
  });
});
