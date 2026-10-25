/* Provider configuration and model labels shared by inference/UI. */
let appState = null;
export function configureProviders(state) { appState = state; }

const DEFAULT_MODELS = {
  groq: 'openai/gpt-oss-120b',
  openrouter: 'openai/gpt-oss-120b',
  gemini: 'gemini-3.6-flash',
  mistral: 'mistral-small-latest',
  antigravity: 'gemini-3.8-flash',
};

export function getModel(provider) {
  return appState.modelSelections?.[provider] || DEFAULT_MODELS[provider] || 'openai/gpt-oss-120b';
}

export function providerLabel(provider) {
  return ({
    groq: 'GroqCloud',
    openrouter: 'OpenRouter',
    gemini: 'Google Gemini',
    mistral: 'Mistral',
    antigravity: 'Antigravity',
  })[provider] || provider;
}

export function providerConfig(provider) {
  const keys = appState.apiKeys;
  switch (provider) {
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/chat/completions', key: keys.groq, model: getModel(provider) };
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        key: keys.openrouter,
        model: getModel(provider),
        extraHeaders: { 'HTTP-Referer': location.origin, 'X-Title': 'Rex AI' },
      };
    case 'mistral':
      return {
        url: 'https://api.mistral.ai/v1/chat/completions',
        key: keys.mistral,
        model: getModel(provider),
      };
    default:
      throw new Error('Unknown OpenAI-compatible provider: ' + provider);
  }
}
