import type { PromptGuard } from "../ports";
import { screenText } from "./injection";

/** The rule-based prompt guard: always available, offline, and explains every flag. */
export const heuristicGuard: PromptGuard = {
  mode: "live",
  adapter: "heuristic",
  screen: async (text) => screenText(text),
};
