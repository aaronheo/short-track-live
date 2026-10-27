// Dev: ask a question from the terminal.
//   npx tsx src/chat/try.ts "Who has won the most 500 m finals?" [model] [reasoning effort]
import 'dotenv/config';
import OpenAI from 'openai';
import { createPool } from '../db/pool.js';
import { Chat } from './chat.js';

const [question = 'Who has won the most 500 m finals?', model = process.env.OPENAI_MODEL ?? 'gpt-5.4-mini', effort] = process.argv.slice(2);
const pool = createPool();
const chat = new Chat(new OpenAI(), pool, { model, reasoningEffort: effort as 'low' | undefined });
const start = Date.now();
let first = 0;
await chat.answer([{ role: 'user', content: question }], {
  step: (t) => console.log(`  · ${t}  (${((Date.now() - start) / 1000).toFixed(1)}s)`),
  delta: (t) => { first ||= Date.now(); process.stdout.write(t); },
  reset: () => process.stdout.write('\n[reset]\n'),
});
console.log(`\n\n${model}${effort ? ` (${effort})` : ''}: first text ${((first - start) / 1000).toFixed(1)}s, done ${((Date.now() - start) / 1000).toFixed(1)}s`);
await pool.end();
