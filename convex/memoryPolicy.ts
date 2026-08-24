/**
 * The ADMISSION POLICY for the agent's durable memory: which proposed edits are allowed to change
 * what the agent believes, and how unconfirmed beliefs weaken over time.
 *
 * WHY THIS EXISTS. Memory used to be one free-form note that the agent REWROTE IN FULL every
 * cycle. SHARP (arXiv 2605.06822) ablates exactly that: bounded atomic edits scored +33.2% return
 * where free-form full rewrites scored -12.1%, because a rewrite makes credit assignment
 * impossible; signal and noise are reshuffled together every round. There is deliberately no
 * "replace everything" operation in this module. The only way to change memory is a small number
 * of attributable edits.
 *
 * WHAT THE MODEL DECIDES AND WHAT CODE DECIDES. A model proposes edits and a separate judge
 * (the `memory_gate` subagent) reviews them, because the thing that proposes a memory must not be
 * the thing that approves it. But the rules below are NOT left to either model: caps, provenance
 * precedence, deduplication and the computed-statistics ban are mechanical, and this codebase's
 * standing principle is that whatever can be checked in code MUST be, since a prompt can be
 * talked out of things. The gate advises; this module decides.
 *
 * Pure: no I/O, no clock, no environment. `now` is always passed in. This module is an input to
 * the agent's REASONING only, never to the risk gate, sizing, or order placement.
 *
 * It lives in `convex/` (not `agent/lib/`) for the same reason as traceAppend.ts: so the MUTATION
 * can enforce these rules itself rather than trusting whichever caller assembled the edits. The
 * tool applies the policy to explain refusals to the model; the mutation re-applies it at the
 * storage boundary, so a future caller cannot grow memory past its caps or slip a directive in.
 */

/**
 * The three kinds of thing worth remembering, separated because they have different lifetimes and
 * different authority. One shared budget is what let a passing remark about oil prices compete
 * with a hard account constraint, and win.
 */
export type MemoryClass =
  /** A standing instruction from Lucien, or a hard account/broker constraint. Outranks the rest. */
  | "directive"
  /** A durable mechanic the agent worked out from outcomes. Decays unless reconfirmed. */
  | "lesson"
  /** A fact about the current regime or portfolio. Expires by default. */
  | "observation";

/** Where a memory came from. The survey's precedence rule: user statement > agent inference. */
export type Provenance = "user" | "agent";

export interface MemoryRow {
  id: string;
  class: MemoryClass;
  /** Coarse grouping ("execution", "risk", "selection"), for retrieval and for error attribution. */
  category: string;
  /** The trigger, as a natural-language predicate: "IF a full close is rejected". */
  condition: string;
  /** What to do when it triggers: "prefer a partial de-risk". */
  action: string;
  provenance: Provenance;
  /** 0..1. Decays while unconfirmed so an unvalidated guess cannot harden into a fact. */
  confidence: number;
  createdAt: number;
  lastConfirmedAt: number;
  /** When this rule's wording was last changed. Drives the churn guard below. */
  lastModifiedAt?: number;
  /** Explicit expiry, when one was set. Observations get one by default. */
  expiresAt?: number;
}

/**
 * Separate budgets per class, so market noise can never evict a rule Lucien set.
 *
 * 26 protected slots in place of 10 contested ones. Caps also force parsimony: at the cap, an add
 * must be paired with a retire, which is SHARP's compactness incentive and keeps the symbolic
 * block small enough to actually steer the model.
 */
export const CLASS_CAPS: Record<MemoryClass, number> = {
  directive: 8,
  lesson: 12,
  observation: 6,
};

/** SHARP proposes at most 3 atomic edits per round. More than that is a rewrite in disguise. */
export const MAX_EDITS_PER_CYCLE = 3;

/**
 * How long a rule is left alone after its wording changes.
 *
 * WHY. Across four consecutive live cycles the agent restated ONE rule: "added a rule to consider
 * partial de-risking" -> "tightened the rule" -> "strengthened the rule to review three days
 * before" -> "strengthened the rule to begin executable partial reductions". The gate admitted
 * every one and no new outcome occurred between them. The atomic-edit constraint held (there was
 * no full rewrite) yet credit assignment is defeated all the same, because a belief that is
 * continually reworded is never actually tested.
 *
 * A rule needing three rewrites in three days has a problem no wording will fix, so the edit is
 * refused and the agent is pointed at the two honest alternatives: leave it and let outcomes judge
 * it, or RETIRE it, which stays allowed precisely so a genuinely wrong rule can still go.
 */
export const MODIFY_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

/** How long an unreconfirmed observation stands before it expires. */
export const OBSERVATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Confidence lost per 30 unconfirmed days, applied to lessons only. */
const LESSON_DECAY_PER_MONTH = 0.15;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** A decayed lesson weakens toward this floor rather than vanishing: it may still be true. */
const MIN_DECAYED_CONFIDENCE = 0.1;

export type Edit =
  | {
      op: "add";
      /** Stable SEMANTIC id chosen by the proposer ("broker_min_position"), as SHARP specifies. */
      id: string;
      class: MemoryClass;
      category: string;
      condition: string;
      action: string;
      provenance: Provenance;
      reason: string;
    }
  | {
      op: "modify";
      id: string;
      condition?: string;
      action?: string;
      confidence?: number;
      reason: string;
    }
  | { op: "retire"; id: string; reason: string };

/** Why an edit was refused. Stable identifiers so alerts and tests can name the rule. */
export type PolicyRule =
  | "edit-budget"
  | "reason-required"
  | "directive-needs-user"
  | "conflicts-with-directive"
  | "class-cap"
  | "duplicate"
  | "computed-stat"
  | "unknown-target"
  | "duplicate-id"
  | "recently-modified";

export interface Decision {
  edit: Edit;
  admitted: boolean;
  rule?: PolicyRule;
  detail?: string;
}

/** Compare conditions and actions on meaning, not on punctuation or casing. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$% ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does this text restate a statistic the code already computes?
 *
 * A memory slot was previously spent on "other = 6W/5L, 50% win rate, GBP 1.92 across 12 closed
 * trades", every number of which arrives fresh from `review_performance` each cycle. Storing it
 * wastes a slot AND goes stale instantly, which is worse than not storing it at all.
 *
 * Deliberately narrow: it looks for the SHAPE of a tally, not merely for digits, so an
 * genuinely useful threshold like "do not open a position above $300" is unaffected.
 */
export function looksLikeComputedStat(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b\d+\s*w\s*\/\s*\d+\s*l\b/.test(t)) return true; // "6W/5L"
  if (/win rate/.test(t) && /\d/.test(t)) return true;
  if (/\bp&l\b/.test(t) && /\d/.test(t)) return true;
  if (/\bclosed trades?\b/.test(t) && /\d/.test(t)) return true;
  return false;
}

function textOf(edit: Extract<Edit, { op: "add" }>): string {
  return `${edit.condition} ${edit.action}`;
}

/**
 * Decide which proposed edits may change memory.
 *
 * Retires are considered before adds, so "retire one, add one" works at the cap regardless of the
 * order they were proposed in. Every refusal names its rule, so a rejected edit is diagnosable
 * rather than silently dropped.
 */
export function admitEdits(
  existing: readonly MemoryRow[],
  edits: readonly Edit[],
  now: number,
): Decision[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const directives = existing.filter((r) => r.class === "directive");
  const seen = new Set(existing.map((r) => `${normalize(r.condition)}|${normalize(r.action)}`));

  // Slots freed by retires in THIS batch, so a paired retire+add fits at the cap.
  const retiring = new Set<string>();
  for (const edit of edits.slice(0, MAX_EDITS_PER_CYCLE)) {
    if (edit.op !== "retire") continue;
    const target = byId.get(edit.id);
    if (target && target.class !== "directive" && edit.reason.trim().length > 0) {
      retiring.add(edit.id);
    }
  }
  const countOf = (cls: MemoryClass): number =>
    existing.filter((r) => r.class === cls && !retiring.has(r.id)).length;
  const added: Record<MemoryClass, number> = { directive: 0, lesson: 0, observation: 0 };
  /** Ids claimed by earlier adds in this same batch, so one batch cannot add the same id twice. */
  const claimedIds = new Set<string>();

  return edits.map((edit, index): Decision => {
    const refuse = (rule: PolicyRule, detail: string): Decision => ({
      edit,
      admitted: false,
      rule,
      detail,
    });

    if (index >= MAX_EDITS_PER_CYCLE) {
      return refuse(
        "edit-budget",
        `at most ${MAX_EDITS_PER_CYCLE} edits per cycle; a larger batch is a rewrite, which is ` +
          "the pattern this design exists to prevent",
      );
    }
    if (edit.reason.trim().length === 0) {
      return refuse("reason-required", "every edit must say what prompted it, or it cannot be audited");
    }

    if (edit.op === "add") {
      if (edit.class === "directive" && edit.provenance !== "user") {
        return refuse(
          "directive-needs-user",
          "a directive states what Lucien or the broker requires; the agent cannot grant itself one",
        );
      }
      if (edit.id.trim().length === 0) {
        return refuse("duplicate-id", "an added memory needs a stable semantic id");
      }
      if (byId.has(edit.id) || claimedIds.has(edit.id)) {
        return refuse("duplicate-id", `id ${edit.id} is already in use; modify it instead of re-adding`);
      }
      if (looksLikeComputedStat(textOf(edit))) {
        return refuse(
          "computed-stat",
          "this restates a figure review_performance recomputes every cycle; memory is for rules",
        );
      }
      const key = `${normalize(edit.condition)}|${normalize(edit.action)}`;
      if (seen.has(key)) {
        return refuse("duplicate", "an equivalent memory is already stored");
      }
      if (edit.class !== "directive") {
        const clash = directives.find(
          (d) =>
            normalize(d.condition) === normalize(edit.condition) &&
            normalize(d.action) !== normalize(edit.action),
        );
        if (clash) {
          return refuse(
            "conflicts-with-directive",
            `directive ${clash.id} already governs this condition and outranks an inferred rule`,
          );
        }
      }
      if (countOf(edit.class) + added[edit.class] >= CLASS_CAPS[edit.class]) {
        return refuse(
          "class-cap",
          edit.class === "directive"
            ? `the ${edit.class} budget (${CLASS_CAPS[edit.class]}) is full, and a directive is ` +
              "never evicted automatically; Lucien must retire one"
            : `the ${edit.class} budget (${CLASS_CAPS[edit.class]}) is full; retire one in the ` +
              "same batch to make room",
        );
      }
      added[edit.class] += 1;
      seen.add(key);
      claimedIds.add(edit.id);
      return { edit, admitted: true };
    }

    const target = byId.get(edit.id);
    if (!target) {
      return refuse("unknown-target", `no memory with id ${edit.id}`);
    }
    if (target.class === "directive") {
      return refuse(
        "directive-needs-user",
        `${edit.id} is a directive; only Lucien may change or retire it`,
      );
    }
    if (edit.op === "modify") {
      const changedAt = target.lastModifiedAt;
      if (changedAt !== undefined && now - changedAt < MODIFY_COOLDOWN_MS) {
        const days = Math.max(1, Math.ceil((MODIFY_COOLDOWN_MS - (now - changedAt)) / 86_400_000));
        return refuse(
          "recently-modified",
          `${edit.id} was reworded ${Math.floor((now - changedAt) / 86_400_000)} day(s) ago. ` +
            `Leave it alone for ${days} more day(s) and let outcomes judge it, or RETIRE it if it ` +
            "is genuinely wrong. Restating a rule is not evidence that it works.",
        );
      }
      const merged = `${edit.condition ?? target.condition} ${edit.action ?? target.action}`;
      if (looksLikeComputedStat(merged)) {
        return refuse(
          "computed-stat",
          "this restates a figure review_performance recomputes every cycle; memory is for rules",
        );
      }
    }
    return { edit, admitted: true };
  });
}

/**
 * Apply the passage of time: expire what has lapsed, weaken what has not been reconfirmed.
 *
 * The survey's guard against reflection pathologies. Without it, a belief formed in one market
 * regime stands forever with the same authority as a hard constraint, which is precisely what
 * happened: an observation about one oil-price episode sat in memory as standing guidance long
 * after it stopped being true.
 *
 * Directives are exempt entirely. They are not the agent's inferences and do not rot.
 */
export function decayed(
  rows: readonly MemoryRow[],
  now: number,
): { active: MemoryRow[]; expired: MemoryRow[] } {
  const active: MemoryRow[] = [];
  const expired: MemoryRow[] = [];

  for (const r of rows) {
    if (r.class === "directive") {
      active.push(r);
      continue;
    }
    const explicit = r.expiresAt !== undefined && now >= r.expiresAt;
    const lapsed =
      r.class === "observation" && now - r.lastConfirmedAt >= OBSERVATION_TTL_MS;
    if (explicit || lapsed) {
      expired.push(r);
      continue;
    }
    if (r.class === "lesson") {
      const months = (now - r.lastConfirmedAt) / MONTH_MS;
      const confidence = Math.max(
        MIN_DECAYED_CONFIDENCE,
        r.confidence - months * LESSON_DECAY_PER_MONTH,
      );
      active.push(confidence === r.confidence ? r : { ...r, confidence });
      continue;
    }
    active.push(r);
  }
  return { active, expired };
}

/**
 * Render memory for the prompt as a STRUCTURED block, grouped by class and ordered by authority.
 *
 * SHARP is explicit that rules go in "as a structured symbolic block, not free-form prose": the
 * shape is what lets the model apply a rule as a rule instead of reading it as a paragraph.
 */
export function renderMemoryBlock(rows: readonly MemoryRow[]): string {
  const order: MemoryClass[] = ["directive", "lesson", "observation"];
  const lines: string[] = [];
  for (const cls of order) {
    const group = rows.filter((r) => r.class === cls);
    if (group.length === 0) continue;
    lines.push(`[${cls.toUpperCase()}]`);
    for (const r of group) {
      const confidence = cls === "directive" ? "" : ` (confidence ${r.confidence.toFixed(2)})`;
      lines.push(`- ${r.id} [${r.category}] ${r.condition} -> ${r.action}${confidence}`);
    }
  }
  return lines.join("\n");
}
