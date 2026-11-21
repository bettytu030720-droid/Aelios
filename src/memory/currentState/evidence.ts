import type { MessageRecord } from "../../types";
import { groundCandidate } from "../grounding";
import type { ExtractedMemory } from "../extract";
import { isExplicitDecisionText } from "./decisionCues";
import { decisionKey } from "./scopeKey";

export function findDecisionConfirmation(
  candidate: ExtractedMemory,
  messages: readonly MessageRecord[]
): MessageRecord | undefined {
  const { decision, evidence_quote: quote } = candidate;
  if (candidate.type !== "decision" || candidate.attributed_role !== "user" ||
    !decision || !decisionKey(decision.scope_key) || !quote ||
    !quote.toLowerCase().includes(decision.value.toLowerCase()) ||
    !candidate.content.toLowerCase().includes(decision.value.toLowerCase())) return undefined;
  const cited = new Set(candidate.source_message_ids);
  return messages.filter(message =>
    cited.has(message.id) && message.role === "user" &&
    isExplicitDecisionText(message.content) && groundCandidate(candidate, [message]).length > 0
  ).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}
