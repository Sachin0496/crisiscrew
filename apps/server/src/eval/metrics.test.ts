import { describe, expect, it } from "vitest";
import { score, type Outcome } from "./metrics";

const hit = (over: Partial<Outcome> = {}): Outcome => ({
  kind: "checkout_release",
  expectedIncident: true,
  fired: true,
  linkedLabeled: 5,
  linkedTotal: 5,
  labeledTotal: 5,
  latencyTickets: 4,
  latencySec: 20,
  rootCorrect: true,
  ...over,
});
const quiet = (over: Partial<Outcome> = {}): Outcome => ({
  kind: "quiet",
  expectedIncident: false,
  fired: false,
  linkedLabeled: 0,
  linkedTotal: 0,
  labeledTotal: 0,
  ...over,
});

describe("score", () => {
  it("is perfect when every incident is caught and nothing else fires", () => {
    expect(score([hit(), hit(), quiet(), quiet()])).toMatchObject({ tp: 2, fp: 0, fn: 0, tn: 2, precision: 1, recall: 1, f1: 1 });
  });

  it("counts a quiet run that fires as a false alarm", () => {
    const s = score([hit(), hit(), quiet({ fired: true, linkedTotal: 4 })]);
    expect(s).toMatchObject({ tp: 2, fp: 1, fn: 0 });
    expect(s.precision).toBeCloseTo(2 / 3, 10);
  });

  it("counts an incident opened mostly on the wrong tickets as both a false alarm and a miss", () => {
    const s = score([hit({ linkedLabeled: 2, labeledTotal: 5, linkedTotal: 6 })]);
    expect(s).toMatchObject({ tp: 0, fp: 1, fn: 1, precision: 0, recall: 0 });
  });

  it("counts an incident run that never fires as a miss", () => {
    expect(score([hit({ fired: false, linkedLabeled: 0, linkedTotal: 0 }), hit()])).toMatchObject({ tp: 1, fn: 1, recall: 0.5 });
  });

  it("averages linking over caught incidents and takes the median latency", () => {
    const s = score([
      hit({ linkedLabeled: 4, linkedTotal: 5, labeledTotal: 4, latencyTickets: 4, latencySec: 10 }),
      hit({ linkedLabeled: 3, linkedTotal: 3, labeledTotal: 6, latencyTickets: 5, latencySec: 30, rootCorrect: false }),
      hit({ latencyTickets: 6, latencySec: 50 }),
    ]);
    // linking precision (4/5 + 3/3 + 5/5) / 3; linking recall (4/4 + 3/6 + 5/5) / 3
    expect(s.linkPrecision).toBeCloseTo((0.8 + 1 + 1) / 3, 10);
    expect(s.linkRecall).toBeCloseTo((1 + 0.5 + 1) / 3, 10);
    expect(s.medianLatencyTickets).toBe(5);
    expect(s.medianLatencySec).toBe(30);
    expect(s.rootAccuracy).toBeCloseTo(2 / 3, 10);
  });

  it("counts every extra incident opened in a run as a false alarm", () => {
    expect(score([hit({ extraIncidents: 1 }), quiet({ fired: true, linkedTotal: 4, extraIncidents: 1 })])).toMatchObject({ tp: 1, fp: 3 });
  });

  it("reports precision as null when nothing fired at all", () => {
    expect(score([quiet(), quiet()]).precision).toBeNull();
  });
});
