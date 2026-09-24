import { describe, expect, it } from "vitest";
import { parseCustomer, parseRoute, routeHref, ROUTES } from "./router";

describe("parseRoute", () => {
  it("reads each page from its hash", () => {
    expect(parseRoute("#/incident")).toBe("incident");
    expect(parseRoute("#/customers")).toBe("customers");
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
