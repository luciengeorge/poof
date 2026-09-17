/**
 * Minimal client for TypeSafe's System One endpoint (the model is "Jev").
 *
 * WHAT IT IS FOR HERE. Jev is a fast, cheap, calibrated classifier: it answers typed questions
 * over text and returns a probability distribution plus a confidence, at $0.042 per million input
 * tokens with free output. That makes it the right tool for the judgement-shaped checks poof runs
 * over text many times a cycle: is this headline a fresh, stock-specific catalyst; is it already
 * priced in; which strategy bucket does it fall in.
 *
 * WHAT IT IS NOT FOR. Direction from a bare price feed. TypeSafe's own use-case map frames
 * prediction as "extract features to feed a forecasting model", never as forecasting directly, and
 * a calibrated 80% on noise is a well-calibrated coin. Nothing this module returns feeds the risk
 * gate, sizing, or order placement. Every use is either an annotation the agent may weigh, or a
 * shadow forecast recorded so its calibration can be measured against real outcomes before it is
 * ever allowed to influence a trade.
 *
 * Raw fetch rather than the SDK, matching how every other provider in agent/lib is wired: one
 * fewer dependency, and the whole request shape is visible in this file.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/**
 * Pinned, not the `jev-latest` alias. We are MEASURING calibration, and a measurement against a
 * model that can change underneath us without a change on our side is not a measurement. The
 * response also reports which version answered, and that is stored beside every shadow forecast.
 */
export const JEV_MODEL = "jev-1.13.0";
export const JEV_TIMEOUT_MS = 8_000;

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export type JevQuestion = NoulQuestion | ChoiceQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer;

export interface JevResponse<Q extends Record<string, JevQuestion>> {
  model: string;
  answers: { [K in keyof Q]: Q[K] extends NoulQuestion ? NoulAnswer : ChoiceAnswer };
  usage: { input_tokens: number; output_tokens: number };
}

/** Text-only, as the API requires: a string, or an object/array of strings. */
export type JevState = string | Record<string, unknown> | unknown[];

export interface JevClient {
  ask<Q extends Record<string, JevQuestion>>(state: JevState, questions: Q): Promise<JevResponse<Q>>;
}

export class JevError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

function isFiniteUnit(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
}

/**
 * Validate the answer for one question. A malformed answer is an error, not a default: a missing
 * probability quietly becoming 0.5 would be recorded as a forecast and scored as one.
 */
function validateAnswer(id: string, question: JevQuestion, raw: unknown): JevAnswer {
  if (typeof raw !== "object" || raw === null) throw new JevError(`answer ${id}: not an object`);
  const a = raw as Record<string, unknown>;
  if (question.type === "noul") {
    if (a.type !== "noul" || !isFiniteUnit(a.noul)) throw new JevError(`answer ${id}: malformed noul`);
    return { type: "noul", noul: a.noul };
  }
  if (a.type !== "choice" || typeof a.choice !== "string" || !isFiniteUnit(a.confidence)) {
    throw new JevError(`answer ${id}: malformed choice`);
  }
  const probabilities = a.probabilities;
  if (typeof probabilities !== "object" || probabilities === null) {
    throw new JevError(`answer ${id}: missing probabilities`);
  }
  const probs: Record<string, number> = {};
  for (const option of Object.keys(question.criteria)) {
    const p = (probabilities as Record<string, unknown>)[option];
    if (!isFiniteUnit(p)) throw new JevError(`answer ${id}: probability missing for ${option}`);
    probs[option] = p;
  }
  if (!(a.choice in question.criteria)) throw new JevError(`answer ${id}: choice outside criteria`);
  return { type: "choice", choice: a.choice, probabilities: probs, confidence: a.confidence };
}

export class HttpJevClient implements JevClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
    model: string = JEV_MODEL,
    timeoutMs: number = JEV_TIMEOUT_MS,
  ) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async ask<Q extends Record<string, JevQuestion>>(state: JevState, questions: Q): Promise<JevResponse<Q>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new JevError(`Jev HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { model?: unknown; answers?: unknown; usage?: unknown };
    if (typeof body.model !== "string" || typeof body.answers !== "object" || body.answers === null) {
      throw new JevError("Jev response missing model or answers");
    }
    const answers: Record<string, JevAnswer> = {};
    for (const [id, question] of Object.entries(questions)) {
      answers[id] = validateAnswer(id, question, (body.answers as Record<string, unknown>)[id]);
    }
    const usage = (body.usage ?? {}) as { input_tokens?: unknown; output_tokens?: unknown };
    return {
      model: body.model,
      answers: answers as JevResponse<Q>["answers"],
      usage: {
        input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      },
    };
  }
}

/**
 * Null when unconfigured. Every caller treats null as "no annotation" and carries on, the same
 * way an absent X or Exa key degrades elsewhere: Jev is an observer here and its absence must
 * never change what the agent can do.
 */
export function jevFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: typeof fetch,
): JevClient | null {
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) return null;
  return new HttpJevClient(key, fetchImpl);
}
