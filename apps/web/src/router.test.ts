import { describe, expect, it } from "vitest";
import { parseRoute, routeHref, ROUTES } from "./router";

describe("parseRoute", () => {
  it("reads each page from its hash", () => {
    expect(parseRoute("#/incident")).toBe("incident");
    expect(parseRoute("#/tickets")).toBe("tickets");
    expect(parseRoute("#/agents")).toBe("agents");
    expect(parseRoute("#/governance")).toBe("governance");
  });

  it("opens the incident page for an empty or unknown hash", () => {
    expect(parseRoute("")).toBe("incident");
    expect(parseRoute("#")).toBe("incident");
    expect(parseRoute("#/billing")).toBe("incident");
  });

  it("builds a link that parses back to the same page", () => {
    for (const route of ROUTES) expect(parseRoute(routeHref(route.id))).toBe(route.id);
  });
});
