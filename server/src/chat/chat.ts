// Ask: answers questions about results with OpenAI, looking things up with
// the tools in tools.ts. Stateless: the app sends the whole conversation each
// time and nothing is stored.

import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type { FunctionTool, Response, ResponseInputItem } from 'openai/resources/responses/responses';
import type pg from 'pg';
import { ChatTools, TOOL_DEFINITIONS } from './tools.js';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface ChatEvents {
  /** A lookup finished ("Searched athletes for “van”"). */
  step(text: string): void;
  /** More answer text. */
  delta(text: string): void;
  /** Drop the text streamed so far (the model wrote a preamble, then looked something up). */
  reset(): void;
}

export interface ChatOptions {
  model: string;
  /** For reasoning models; 'low' answers faster. Leave unset for others. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  now?: () => Date;
}

const MAX_TURNS = 8;
const MAX_TOOL_JSON = 24_000;

const TOOLS: FunctionTool[] = TOOL_DEFINITIONS.map((t) => ({
  type: 'function', name: t.function.name, description: t.function.description,
  parameters: t.function.parameters as Record<string, unknown>, strict: false,
}));

export class Chat {
  private readonly tools: ChatTools;

  constructor(private readonly client: OpenAI, private readonly pool: pg.Pool, private readonly opts: ChatOptions) {
    this.tools = new ChatTools(pool);
  }

  /**
   * Streams one answer, looking things up as the model asks. Uses the
   * Responses API with store: false, so OpenAI keeps nothing between requests;
   * reasoning is carried across tool calls as encrypted content.
   */
  async answer(messages: ChatMessage[], events: ChatEvents, signal?: AbortSignal): Promise<void> {
    const instructions = await this.systemPrompt();
    const input: ResponseInputItem[] = messages.map((m) => ({ role: m.role, content: m.content }));
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = await this.client.responses.create({
        model: this.opts.model,
        instructions,
        input,
        tools: TOOLS,
        stream: true,
        store: false,
        include: ['reasoning.encrypted_content'],
        max_output_tokens: 6000,
        ...(this.opts.reasoningEffort ? { reasoning: { effort: this.opts.reasoningEffort } } : {}),
      }, { signal });

      let text = '';
      let done: Response | null = null;
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          text += event.delta;
          events.delta(event.delta);
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          done = event.response;
        } else if (event.type === 'response.failed') {
          throw new Error(event.response.error?.message ?? 'OpenAI response failed');
        }
      }
      if (!done) throw new Error('OpenAI stream ended without a response');
      const calls = done.output.filter((item) => item.type === 'function_call');
      if (!calls.length) return;

      if (text) events.reset();
      input.push(...toResponseInputItems(done.output));
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.arguments || '{}') as Record<string, unknown>; } catch { /* the tool reports bad input */ }
        const result = await this.tools.run(call.name, args);
        events.step(result.step);
        let json = JSON.stringify(result.data);
        if (json.length > MAX_TOOL_JSON) json = `${json.slice(0, MAX_TOOL_JSON)}… (cut off; ask for less)`;
        input.push({ type: 'function_call_output', call_id: call.call_id, output: json });
      }
    }
    events.delta('\n\nI couldn’t finish looking that up. Try asking something narrower.');
  }

  private async systemPrompt(): Promise<string> {
    const now = (this.opts.now ?? (() => new Date()))();
    const res = await this.pool.query<{ first: string | null; last: string | null }>(
      `select to_char(min(starts_on), 'Mon YYYY') as first, to_char(max(ends_on), 'Mon DD, YYYY') as last
       from event where state <> 'upcoming'`);
    const { first, last } = res.rows[0] ?? {};
    return `You answer questions about ISU short track speed skating results in the Short Track Live app.
Today is ${now.toISOString().slice(0, 10)}. The data covers ISU events from ${first ?? 'Oct 2025'} to ${last ?? 'now'}: World Cups (called the World Tour from 2025/26), European, Four Continents, World, World Team and Junior Championships, Junior World Cups, and the 2026 Olympics. Earlier Olympics and anything before ${first ?? 'Oct 2025'} aren't available.

- Look facts up with the tools; never answer results from memory. If the data doesn't cover something, say so plainly.
- Unless the question says otherwise, count senior events only (leave out junior events), and say so when it matters.
- A medal is a place 1-3 in an A final (a heat named "Final" or "Final A").
- Start with the answer in one sentence, then add only what helps: two or three short paragraphs at most. Use **bold** for the key name or number. No tables or headings; a short list is fine.
- Link athletes and races the tools returned, using their ids: [Xandra Velzeboer](shorttrack://athlete/47) and [the Olympic final](shorttrack://heat/1685). Link each one once, the first time it comes up.
- Times are in seconds as written in the data (40.064, 1:24.537). Write dates like Oct 25, 2026.
- Answer in the language of the question.`;
  }
}

/** Requests per rolling hour, for the whole server (it's a personal app). */
export class RateLimit {
  private times: number[] = [];

  constructor(private readonly perHour: number) {}

  take(now = Date.now()): boolean {
    this.times = this.times.filter((t) => now - t < 3_600_000);
    if (this.times.length >= this.perHour) return false;
    this.times.push(now);
    return true;
  }
}
