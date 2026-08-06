import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Independent judge of proposed DURABLE MEMORY. Given candidate memory edits (and any raw " +
    "quotes from Lucien), decides for each whether it is a genuine, durable learning worth a " +
    "memory slot, and in which class, returning structured verdicts only. It cannot write memory, " +
    "trade, or change anything: it only judges. Call it before `amend_memory`.",
  // Same model as the rest of the system. `reasoning` is REQUIRED: the GPT-5.6 series defaults to
  // reasoning "none", and a gate with reasoning disabled would wave everything through while still
  // looking like it ran. "high" rather than xhigh because judging a handful of candidates against
  // a fixed rubric is a bounded task, unlike forming a trade thesis.
  model: "openai/gpt-5.6-luna",
  reasoning: "high",
});
