// One definition for the registration script and the Worker, so the name and limits never drift apart.
export const COMMAND = {
  name: 'ffbot',
  description: 'Ask about World of Warcraft. Answers come from Wowhead and the armory, written by Google Gemini.',
  options: [{ type: 3, name: 'question', description: 'Your question, like: where does Thunderfury drop?', required: true, max_length: 300 }],

  // Servers only, no direct messages or user installs.
  integration_types: [0],
  contexts: [0],
};
