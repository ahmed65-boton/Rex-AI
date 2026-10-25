/* Provider-neutral tool definitions shared by cloud inference adapters. */
const TOOLS_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'terminal',
      description: 'Execute a shell command on the host machine (PowerShell on Windows, bash/sh on macOS/Linux). MEDIUM/HIGH-risk commands require user approval before execution.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute (PowerShell on Windows, bash/sh elsewhere).' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the attached workspace directory.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write text content to a file in the attached workspace directory.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file path.' }, content: { type: 'string', description: 'Text content to write.' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web with Exa for current information. Use this for recent facts, news, releases, documentation, and anything that may have changed.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Precise web search query.' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt using Rex image generation. Use this when the user asks to create, draw, generate, visualize, or make an image.',
      parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Detailed image-generation prompt.' }, model: { type: 'string', description: 'Pollinations image model, usually flux.' }, width: { type: 'integer', description: 'Image width from 256 to 2048.' }, height: { type: 'integer', description: 'Image height from 256 to 2048.' } }, required: ['prompt'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description: 'Update Rex long-term memory about the user. Use only for stable facts, preferences, goals, or ongoing projects the user voluntarily shares and would reasonably expect to be remembered across chats. Do not store sensitive personal information unless the user explicitly asks. Use remove to delete outdated entries.',
      parameters: {
        type: 'object',
        properties: {
          add: { type: 'array', items: { type: 'string' }, description: 'New concise memory entries to add.' },
          remove: { type: 'array', items: { type: 'string' }, description: 'Existing memory entries to remove, using their exact text.' },
        },
      },
    },
  },

];

const GEMINI_TOOLS = [{ functionDeclarations: TOOLS_SCHEMA.map(t => ({
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
})) }];

export { TOOLS_SCHEMA, GEMINI_TOOLS };