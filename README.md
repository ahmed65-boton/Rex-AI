# Rex AI

Rex AI is a Windows browser-based hybrid AI agent. It combines cloud LLMs, Exa web search, a PowerShell 7 terminal/workspace bridge, and Pollinations image generation.

## Providers

- **GroqCloud** — default `openai/gpt-oss-120b`
- **OpenRouter** — OpenAI-compatible; default `openai/gpt-oss-120b`
- **Google Gemini** — native Gemini API; default `gemini-3.6-flash`
- **Exa** — current web search
- **Pollinations** — image generation; default image model `flux`

The old Cloudflare Workers AI, Unsloth, Hugging Face, and Cloudflare R2 settings are no longer part of Rex because they were not required by the current project.

## Image generation

Rex exposes a `generate_image` agent tool. When the user asks Rex to create/draw/generate an image, the selected cloud model can call this tool. The local Python bridge sends the request to Pollinations and stores the generated image under `generated_images/`, so a Pollinations secret key is not exposed to browser JavaScript.

Pollinations currently supports image generation through `https://gen.pollinations.ai/image/{prompt}` and `/v1/images/generations`. Its documentation says secret `sk_` keys are intended for server-side apps; free Pollen is available for prototypes/testing and can also be earned through quests.

## API_Keys.txt

Supported labels:

```text
Gemini: YOUR_GEMINI_API_KEY
OpenRouter: YOUR_OPENROUTER_API_KEY
OpenRouter model: openai/gpt-oss-120b
GroqCloud: YOUR_GROQ_API_KEY
Exa: YOUR_EXA_API_KEY
Pollinations: YOUR_POLLINATIONS_API_KEY
Pollinations model: flux
```

A Pollinations secret key should stay in `API_Keys.txt`; do not put it into frontend JavaScript.

## Start Rex

PowerShell 7 is required. Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\rex.ps1
```

The bridge serves the UI on `http://localhost:8000/index.html` and provides WebSocket workspace/terminal access on `127.0.0.1:8765`.

## Settings and model selection

The Settings screen is split into three sections:

- **General** — appearance (`System`, `Light`, or `Dark`) and the name Rex should call you.
- **API Keys** — upload a supported `API_Keys.txt` file or enter provider keys in the UI.
- **Model** — GroqCloud, OpenRouter, and Google Gemini each have their own model selector. Rex attempts to load the live model list from each provider when a key is configured, with the configured/default model retained as a fallback if the list cannot be loaded.

Model selections are stored independently, so changing the OpenRouter model does not change the GroqCloud or Gemini model.

## Runtime model identity

Before each cloud request, Rex adds authoritative runtime metadata to the system instructions containing the current provider and selected model. This prevents a model from simply assuming it is Gemini, GPT, or another model based on prior conversation text.

Rex also stores the last provider/model that successfully accessed each chat. When another provider takes over the same chat, the new model is told which provider and model accessed it previously.

## Storage

Chats, model selections, the selected provider, appearance, user-name preference, and entered provider settings are stored in browser IndexedDB. API keys stored there are not encrypted.
