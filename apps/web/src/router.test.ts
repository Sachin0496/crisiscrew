import { describe, expect, it } from "vitest";
import { parseCustomer, parseRoute, parseTrace, routeHref, ROUTES, traceHref } from "./router";

describe("parseRoute", () => {
  it("reads each page from its hash", () => {
    expect(parseRoute("#/incident")).toBe("incident");
    expect(parseRoute("#/customers")).toBe("customers");
    expect(parseRoute("#/tickets")).toBe("tickets");
    expect(parseRoute("#/traces")).toBe("traces");
    expect(parseRoute("#/governance")).toBe("governance");
  });

  it("sends old Agents links to Traces, which replaced that page", () => {
    expect(parseRoute("#/agents")).toBe("traces");
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

describe("customer links", () => {
  it("points the Customers page at one customer, and round-trips unusual references", () => {
    expect(routeHref("customers", "s03")).toBe("#/customers/s03");
    expect(parseRoute("#/customers/s03")).toBe("customers");
    expect(parseCustomer("#/customers/s03")).toBe("s03");
    expect(parseCustomer(routeHref("customers", "freshdesk:requester:9105"))).toBe("freshdesk:requester:9105");
    expect(parseCustomer("#/customers")).toBeUndefined();
    expect(parseCustomer("#/tickets/s03")).toBeUndefined();
  });
});

describe("trace links", () => {
  it("points the Traces page at one trace", () => {
    const id = "5f0c2b1e-8a7d-4c3e-9b1a-0d2e3f4a5b6c";
    expect(parseRoute(traceHref(id))).toBe("traces");
    expect(parseTrace(traceHref(id))).toBe(id);
    expect(parseTrace("#/traces")).toBeUndefined();
    expect(parseTrace("#/customers/s03")).toBeUndefined();
  });
});
