/* Provider configuration and model labels shared by inference/UI. */
let appState = null;
export function configureProviders(state) { appState = state; }

export function getModel(provider) {
  return appState.modelSelections?.[provider] || (provider === 'gemini' ? 'gemini-3.6-flash' : 'openai/gpt-oss-120b');
}

export function providerLabel(provider) {
  return ({ groq: 'GroqCloud', openrouter: 'OpenRouter', gemini: 'Google Gemini', antigravity: 'Antigravity' })[provider] || provider;
}

export function providerConfig(provider) {
  const keys = appState.apiKeys;
  switch (provider) {
    case 'groq': return { url: 'https://api.groq.com/openai/v1/chat/completions', key: keys.groq, model: getModel(provider) };
    case 'openrouter': return { url: 'https://openrouter.ai/api/v1/chat/completions', key: keys.openrouter, model: getModel(provider), extraHeaders: { 'HTTP-Referer': location.origin, 'X-Title': 'Rex AI' } };
    default: throw new Error('Unknown OpenAI-compatible provider: ' + provider);
  }
}
