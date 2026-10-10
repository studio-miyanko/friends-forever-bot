// Asks one question without Discord: npm run ask -- "Where does Thunderfury drop?"
import { answer } from '../src/agent.js';

const question = process.argv.slice(2).join(' ').trim();
if (!question || !process.env.OPENROUTER_API_KEY) {
  console.error('Usage: OPENROUTER_API_KEY=... npm run ask -- "your question"');
  process.exit(1);
}
console.log(await answer(question, process.env.OPENROUTER_API_KEY));
process.exit(0);
