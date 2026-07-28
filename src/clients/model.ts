import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject, NoObjectGeneratedError } from 'ai';
import type { LanguageModel } from 'ai';
import type { Config } from '../config.ts';
import { createSanitisingFetch } from './json.ts';
import { logger } from '../logger.ts';
import {
  angleSetSchema,
  extractionSchema,
  groundingSchema,
  querySetSchema,
  verificationSchema,
  type ExtractRequest,
  type ExtractedRow,
  type GroundRequest,
  type GroundedRow,
  type QueryRequest,
  type ResearchModel,
  type VerifiedRow,
  type VerifyRequest,
} from '../types.ts';

export const QUERY_SYSTEM = `You turn a research brief into web search queries.
Return raw JSON shaped exactly: {"queries": ["...", "..."]}
Never wrap the JSON in markdown code fences.
Rules:
- Each query is a plain search phrase, not a question, not a boolean expression.
- Vary the angle across queries: sub-category, geography, and organisation type.
- Never repeat, or trivially reword, a query listed as already tried.
- When told which organisations are already covered, deliberately search where those
  would NOT rank: a different country, a different sub-category, a different vocabulary
  ("member network", "founder programme", "chapter", "consortium", "cohort").
- Return exactly the requested number of queries.`;

export const ANGLE_SYSTEM = `You break a research brief into distinct search angles.
An angle is one category of organisation to hunt for, phrased as a short noun phrase
("corporate innovation programmes", "mid-market fintech companies in India").
Rules:
- Derive every angle from the brief itself. If the brief names categories, use those names.
- Angles must be mutually distinct, so that searching one does not surface another's results.
- Cover the whole brief, including any geography or company-stage constraints it states.
- Never invent a category the brief does not imply.
- Return between 4 and 8 angles, most important first.
Return raw JSON shaped exactly: {"angles": ["...", "..."]}
Never wrap the JSON in markdown code fences.`;

export const EXTRACT_SYSTEM = `You extract organisations from web search results for a partner research pipeline.

Return raw JSON shaped exactly: {"rows": [{...}]}, never wrapped in markdown code fences.
Every row object must have exactly these eleven string keys, and no others:
  org_name, event_name, website, event_type, tier, region, dates_raw,
  date_confidence, attendance, event_goal, category
Do not rename them. Do not nest them. Do not add an "evidence" or "facts" key.

Rules:
- Use ONLY facts present in the supplied search results. Never invent attendance figures,
  dates, portfolio sizes, programmes, or metrics.
- If a fact is not in the results, use an empty string. An empty cell is correct; a guess is not.
- website: leave it as an empty string. A separate step resolves the real homepage, so a
  guessed URL is worse than none.
- Extract the organisations named or described in the results, not the website that published
  the article. A listicle about venture studios yields the studios, never the publisher.
- Exclude news articles, blog posts, rankings and "top 10" lists. You want the organisations
  themselves.
- date_confidence is "confirmed" only when the results state an explicit date; otherwise
  "unconfirmed", or "n/a" for year-round programmes.
- tier is one of T1, T2, T3 using the supplied rubric. When evidence is thin, use T3.
- Never return an organisation listed as already covered.
- Deduplicate by domain within your own output.`;

export const GROUND_SYSTEM = `You refine partner research rows using the organisation's own page text.
Preserve the input order and org_name values.

Return raw JSON shaped exactly: {"rows": [{...}]}, never wrapped in markdown code fences.
Every row object must have exactly these eight string keys, and no others:
  org_name, event_type, tier, region, dates_raw, date_confidence, attendance, event_goal

Rules:
- Fill blanks from the page text. Correct a field only when the page contradicts it.
- Use ONLY the supplied page text. If the text is empty or irrelevant, return the row unchanged.
- Never invent numbers. Quote scale figures the way the page states them.
- Upgrade tier only when the page provides explicit evidence for the rubric.`;

export const VERIFY_SYSTEM = `You verify partner-research candidates against an organisation's own website.

Return raw JSON shaped exactly: {"rows": [{...}]}, never wrapped in markdown code fences.
One row per candidate, in the input order, each with exactly these keys:
  org_name, matches_brief, reason, category, event_type, tier, region, dates_raw,
  date_confidence, attendance, event_goal

Judge ONLY from the supplied page text for that organisation.

matches_brief is false only when the page actively contradicts the brief - that is, the page
shows:
- a clearly different kind of organisation than the brief asks for,
- a publisher, directory, news site, listicle or conference organiser rather than the
  organisation itself,
- a parent or unrelated entity that merely shares the name.

A thin, generic or marketing-heavy page is NOT a contradiction. These candidates were already
found by a search built from the brief, so absence of evidence is not evidence of a mismatch:
if the page does not contradict the brief, set matches_brief true.

reason is one short sentence quoting or paraphrasing the page evidence for your decision.

category is the label that best describes what this organisation actually is, judged from
its page. The supplied list is a guide, not a constraint: reuse one of those labels when it
fits, and write a better short label of your own when none of them does. A category that is
not on the list is fine and is never a reason to reject the row.

Fill event_type, tier, region, dates_raw, date_confidence, attendance and event_goal from
the page text. Leave a field empty when the page does not state it. Never invent a number.
tier is T1, T2 or T3 by the supplied rubric.`;

export const TIER_RUBRIC = `T1 = 1000+ members/portfolio, OR presence in 3+ countries, OR top-3 nationally.
T2 = 100-1000 members/portfolio, OR multi-region within one country.
T3 = under 100, OR single-city. Use T3 when evidence is thin.`;

export function createModel(config: Config): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'workers-ai',
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${config.CF_ACCOUNT_ID}/ai/v1`,
    apiKey: config.CF_AI_TOKEN,
    supportsStructuredOutputs: config.CF_STRUCTURED_OUTPUTS,
    fetch: createSanitisingFetch() as unknown as typeof fetch,
  });
  return provider.chatModel(config.CF_MODEL);
}

function joinPrompt(parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join('\n\n');
}

export function createResearchModel(config: Config, model: LanguageModel = createModel(config)): ResearchModel {
  const maxRetries = config.RETRY_ATTEMPTS;

  async function call<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        logger.warn({ label, text: error.text?.slice(0, 400) }, 'model returned no usable object');
        return fallback;
      }
      throw error;
    }
  }

  return {
    async deriveAngles(brief: string): Promise<string[]> {
      return call(
        'angles',
        async () => {
          const { object } = await generateObject({
            model,
            schema: angleSetSchema,
            system: ANGLE_SYSTEM,
            prompt: `Research brief:\n${brief}\n\nList the distinct search angles this brief implies.`,
            temperature: 0.3,
            maxOutputTokens: config.MAX_QUERY_TOKENS,
            maxRetries,
          });
          return object.angles.map((a) => a.trim()).filter(Boolean).slice(0, 8);
        },
        [],
      );
    },

    async generateQueries(req: QueryRequest): Promise<string[]> {
      return call(
        'queries',
        async () => {
          const { object } = await generateObject({
            model,
            schema: querySetSchema,
            system: QUERY_SYSTEM,
            prompt: joinPrompt([
              `Research brief:\n${req.brief}`,
              `Emphasise this angle: ${req.angle}`,
              req.memoryPrompt,
              req.feedback,
              `Produce ${req.count} queries.`,
            ]),
            temperature: req.feedback ? 0.8 : 0.4,
            maxOutputTokens: config.MAX_QUERY_TOKENS,
            maxRetries,
          });
          return object.queries.map((q) => q.trim()).filter(Boolean).slice(0, req.count);
        },
        [],
      );
    },

    async extractRows(req: ExtractRequest): Promise<ExtractedRow[]> {
      return call(
        'extract',
        async () => {
          const { object } = await generateObject({
            model,
            schema: extractionSchema,
            system: EXTRACT_SYSTEM,
            prompt: joinPrompt([
              `Research brief:\n${req.brief}`,
              `Tier rubric:\n${TIER_RUBRIC}`,
              `Category label to use: ${req.angle}`,
              req.covered.length
                ? `Already covered, never return these:\n- ${req.covered.slice(0, 40).join('\n- ')}`
                : undefined,
              `Return at most ${req.maxRows} rows, best first.`,
              `Search results:\n${JSON.stringify(req.hits.slice(0, 40), null, 1)}`,
            ]),
            temperature: 0.2,
            maxOutputTokens: config.MAX_EXTRACT_TOKENS,
            maxRetries,
          });
          return object.rows;
        },
        [],
      );
    },

    async verifyRows(req: VerifyRequest): Promise<VerifiedRow[]> {
      return call(
        'verify',
        async () => {
          const { object } = await generateObject({
            model,
            schema: verificationSchema,
            system: VERIFY_SYSTEM,
            prompt: joinPrompt([
              `Research brief:\n${req.brief}`,
              `Tier rubric:\n${TIER_RUBRIC}`,
              `Allowed categories, copy one verbatim:\n- ${req.categories.join('\n- ')}`,
              `Candidates:\n${JSON.stringify(req.rows.map((r) => ({ org_name: r.org_name, website: r.website, category: r.category })), null, 1)}`,
              `Page text by website:\n${JSON.stringify(Object.fromEntries(req.pages), null, 1)}`,
            ]),
            temperature: 0.1,
            maxOutputTokens: config.MAX_EXTRACT_TOKENS,
            maxRetries,
          });
          return object.rows;
        },
        [],
      );
    },

    async groundRows(req: GroundRequest): Promise<GroundedRow[]> {
      return call(
        'ground',
        async () => {
          const { object } = await generateObject({
            model,
            schema: groundingSchema,
            system: GROUND_SYSTEM,
            prompt: joinPrompt([
              `Tier rubric:\n${TIER_RUBRIC}`,
              `Rows:\n${JSON.stringify(req.rows, null, 1)}`,
              `Page text by website:\n${JSON.stringify(Object.fromEntries(req.pages), null, 1)}`,
            ]),
            temperature: 0.1,
            maxOutputTokens: config.MAX_EXTRACT_TOKENS,
            maxRetries,
          });
          return object.rows;
        },
        [],
      );
    },
  };
}
