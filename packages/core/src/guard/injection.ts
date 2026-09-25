import { TOOL_NAMES, type GuardVerdict } from "@crisiscrew/contracts";

/**
 * The built-in prompt-injection guard: transparent rules with weights, so
 * every flag says exactly why. It runs offline in well under a millisecond.
 * A dedicated model (Lakera Guard, Llama Prompt Guard) can replace it through
 * the PromptGuard port; this one is the floor that always works.
 *
 * Scoring: each matched rule contributes its weight w, combined as
 * 1 - Π(1 - w). A text is flagged at 0.5 or more, so a strong signal flags
 * alone and weak signals flag only together. A customer asking for a refund
 * of a real amount is never flagged for that alone.
 */

type Rule = { code: string; weight: number; pattern: RegExp };

const TOOL_PATTERN = new RegExp(`\\b(${TOOL_NAMES.join("|")})\\b`, "i");

const RULES: Rule[] = [
  {
    code: "override_instructions",
    weight: 0.8,
    pattern:
      /\b(ignore|disregard|forget|override|bypass|skip)\b[^.!?\n]{0,40}\b(instructions?|rules|prompts?|directives|guidelines|guidance|guardrails|polic(?:y|ies)|system (?:message|prompt)|safety (?:rules|checks))\b/i,
  },
  { code: "override_instructions", weight: 0.8, pattern: /\b(previous|prior|earlier|above|original)\s+(instructions?|rules|prompts?|guidelines)\s+(are|were|is)\s+(outdated|obsolete|void|cancelled|revoked|no longer)/i },
  // Hinglish and Hindi: "pichle saare instructions ignore karo", "निर्देशों को अनदेखा करो".
  { code: "override_instructions", weight: 0.8, pattern: /\b(pichhle|pichle|purane|saare|sabhi)\b[^.!?\n]{0,30}\b(instructions?|nirdesh|rules)\b[^.!?\n]{0,20}\b(ignore|bhool|bhul|chhod)/i },
  { code: "override_instructions", weight: 0.8, pattern: /निर्देश[^।.!?\n]{0,30}(अनदेखा|भूल|नजरअंदाज)/ },
  {
    code: "role_hijack",
    weight: 0.7,
    pattern:
      /\b(you are now|from now on you are|act as|pretend (?:to be|you are)|roleplay as|you must now act as)\b\s+(?:an?\s+|the\s+|my\s+)?(admin|administrator|system|developer|root|superuser|assistant|ai|bot|agent|dan|jailbroken|unrestricted|approver|manager)\b/i,
  },
  { code: "role_hijack", weight: 0.7, pattern: /\b(developer|debug|god|jailbreak|unrestricted)\s+mode\b/i },
  // Weaker: "new instructions:" may be a customer quoting a help article, so it only flags with something else.
  { code: "role_hijack", weight: 0.4, pattern: /\b(new|updated|real|actual)\s+(instructions?|task|directive|system prompt)\s*[:\-—]/i },
  {
    code: "prompt_exfiltration",
    weight: 0.8,
    pattern:
      /\b(reveal|show|print|display|tell me|repeat|output|leak|send me|dump)\b[^.!?\n]{0,30}\b(system prompt|your (?:instructions|prompt|rules|system prompt)|api[ _-]?keys?|secrets?|credentials|env(?:ironment)? variables|\.env|access tokens?)\b/i,
  },
  { code: "tool_invocation", weight: 0.7, pattern: TOOL_PATTERN },
  { code: "tool_invocation", weight: 0.6, pattern: /\b(call|invoke|run|execute|trigger)\s+(?:the\s+)?(?:\w+\s+)?(tool|function|api|endpoint|command)\b|"arguments"\s*:|tools\/call/i },
  {
    code: "authority_claim",
    weight: 0.5,
    pattern:
      /\bas (?:the|an|your) (admin|administrator|ceo|cto|manager|supervisor|developer|engineer|approver)\b|\b(pre-?approved|i (?:hereby )?(?:authori[sz]e|approve) (?:a|an|the|this|every|all)\b)|\bAPR-\d{3,}\b|\bapproval (?:id|code)\b/i,
  },
  // Weaker: a customer may truthfully say their refund was already approved.
  { code: "authority_claim", weight: 0.3, pattern: /\b(already approved|approved by (?:your|the) (?:manager|team|admin))\b/i },
  {
    code: "money_directive",
    weight: 0.2,
    pattern: /\b(issue|give|send|transfer|credit|pay|refund|approve)\b[^.!?\n]{0,30}(?:₹|\brs\.?\s?|\binr\s?)\s?\d[\d,]{3,}/i,
  },
  // Money for everyone at once is never a customer's own request. (Tuned on the tune split of scenarios/security.)
  {
    code: "money_directive",
    weight: 0.5,
    pattern:
      /\b(everyone|every customer|all customers|all users)\b[^.!?\n]{0,30}\b(credit|refund|pay|compensat)|\b(credit|refund|pay|compensate)\s+(everyone|every customer|all customers|all users)\b/i,
  },
  { code: "hidden_text", weight: 0.6, pattern: /[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/u },
  {
    code: "prompt_markup",
    weight: 0.6,
    pattern: /<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?(?:INST|SYS)\]|<<\/?SYS>>|<\/?system>|^\s*#{2,}\s*(?:system|instruction)|BEGIN (?:SYSTEM|ADMIN) PROMPT/im,
  },
  // Weaker: "System:" at the start of a line may be a pasted error message, so it only flags with something else.
  { code: "prompt_markup", weight: 0.4, pattern: /^\s*(?:system|assistant)\s*(?:prompt)?\s*:\s*\S/im },
  {
    code: "code_injection",
    weight: 0.5,
    pattern:
      /['"]\s*(?:or|and)\s+'?\d+'?\s*=\s*'?\d+|;\s*(?:drop|delete|truncate|insert|update|alter)\s+(?:table|from|into)\b|\bunion\s+(?:all\s+)?select\b|<script\b|javascript:/i,
  },
  { code: "encoded_payload", weight: 0.5, pattern: /[A-Za-z0-9+/]{60,}={0,2}/ },
];

export const FLAG_THRESHOLD = 0.5;

/** Scores text for instruction-like content aimed at an AI system. */
export function screenText(text: string): GuardVerdict {
  // One contribution per code, its strongest matching rule, so repeating a phrase doesn't add up.
  const best = new Map<string, { weight: number; match: string }>();
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (!m) continue;
    const current = best.get(rule.code);
    if (!current || rule.weight > current.weight) best.set(rule.code, { weight: rule.weight, match: excerpt(text, m.index, m[0].length) });
  }
  let keep = 1;
  for (const { weight } of best.values()) keep *= 1 - weight;
  const score = Number((1 - keep).toFixed(3));
  return { flagged: score >= FLAG_THRESHOLD, score, reasons: [...best.keys()], guard: "heuristic", matches: [...best.values()].map((b) => b.match) };
}

function excerpt(text: string, at: number, length: number): string {
  const visible = text.slice(at, at + Math.min(length, 60)).replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069]/g, "·");
  return visible.length < length ? `${visible}…` : visible;
}
