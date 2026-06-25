const EXA_BASE = "https://api.exa.ai";

export interface ExaResult {
  title: string;
  url: string;
  publishedDate: string | null;
  author: string | null;
  text: string | null;
  summary: string | null;
}

export interface ExaSearchOpts {
  numResults?: number;
  category?: string;
  startPublishedDate?: string;
  text?: boolean | { maxCharacters?: number };
  summary?: boolean;
}

export interface ExaConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class ExaError extends Error {
  status: number;
  body: string;
  rateLimited: boolean;
  constructor(status: number, body: string) {
    super(`Exa API error ${status}: ${body}`);
    this.name = "ExaError";
    this.status = status;
    this.body = body;
    this.rateLimited = status === 429;
  }
}

interface RawExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  summary?: string;
}

export class ExaProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: ExaConfig) {
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async search(query: string, opts: ExaSearchOpts = {}): Promise<ExaResult[]> {
    const contents: Record<string, unknown> = {};
    if (opts.text !== undefined) contents.text = opts.text;
    if (opts.summary !== undefined) contents.summary = opts.summary;

    const body: Record<string, unknown> = { query };
    if (opts.numResults !== undefined) body.numResults = opts.numResults;
    if (opts.category !== undefined) body.category = opts.category;
    if (opts.startPublishedDate !== undefined) {
      body.startPublishedDate = opts.startPublishedDate;
    }
    if (Object.keys(contents).length > 0) body.contents = contents;

    const res = await this.fetchImpl(`${EXA_BASE}/search`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ExaError(res.status, text);

    const parsed = JSON.parse(text) as { results?: RawExaResult[] };
    return (parsed.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      publishedDate: r.publishedDate ?? null,
      author: r.author ?? null,
      text: r.text ?? null,
      summary: r.summary ?? null,
    }));
  }
}

export function exaFromEnv(fetchImpl?: typeof fetch): ExaProvider {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("EXA_API_KEY is not set");
  return new ExaProvider({ apiKey, fetchImpl });
}
