"""Image generation, speech transcription, and speech synthesis."""
import base64
import json
import os
import urllib.request
import urllib.error
import urllib.parse
import uuid

from .api_keys import find_api_key_file, _api_key

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def generate_image(prompt, model="flux", width=1024, height=1024):
    """Generate an image through Pollinations without exposing its secret key to the browser."""
    _, keys = find_api_key_file()
    api_key = keys.get("pollinations")
    if not api_key or api_key.startswith("YOUR_"):
        raise RuntimeError("Pollinations API key is not configured in API_Keys.txt.")

    model = str(keys.get("pollinationsModel") or model or "flux").strip()
    try:
        width = max(256, min(2048, int(width)))
        height = max(256, min(2048, int(height)))
    except (TypeError, ValueError):
        width, height = 1024, 1024

    encoded_prompt = urllib.parse.quote(str(prompt).strip(), safe="")
    params = urllib.parse.urlencode({"model": model, "width": width, "height": height, "nologo": "true"})
    url = f"https://gen.pollinations.ai/image/{encoded_prompt}?{params}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}", "User-Agent": "Rex-AI/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        content_type = response.headers.get_content_type() or "image/jpeg"
        data = response.read()

    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg"}.get(content_type, ".jpg")
    out_dir = os.path.join(APP_DIR, "generated_images")
    os.makedirs(out_dir, exist_ok=True)
    filename = f"rex_{uuid.uuid4().hex}{ext}"
    path = os.path.join(out_dir, filename)
    with open(path, "wb") as f:
        f.write(data)
    return {"url": f"/generated_images/{filename}", "model": model, "width": width, "height": height, "contentType": content_type}


def transcribe_audio(audio_b64, mime_type='audio/webm'):
    api_key = _api_key('groq')
    try:
        audio = base64.b64decode(str(audio_b64), validate=True)
    except Exception as exc:
        raise ValueError(f'Invalid audio data: {exc}') from exc
    if not audio:
        raise ValueError('The recorded audio is empty.')
    if len(audio) > 25 * 1024 * 1024:
        raise ValueError('Audio file is too large for Groq Whisper (25 MB maximum).')

    mime_type = str(mime_type or 'audio/webm').split(';', 1)[0].strip() or 'audio/webm'
    ext = {'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.mp4', 'audio/mpeg': '.mp3'}.get(mime_type, '.webm')
    boundary = f'----RexAI{uuid.uuid4().hex}'
    chunks = []
    def field(name, value):
        chunks.extend([
            f'--{boundary}\r\n'.encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode(), b'\r\n'
        ])
    field('model', 'whisper-large-v3')
    field('language', 'en')
    field('temperature', '0')
    field('prompt', 'English voice dictation for an AI chatbot. Technical terms may include AI, chatbot, code, coding, Python, JavaScript, HTML, CSS, API, Groq, Gemini, and Cloudflare.')
    field('response_format', 'json')
    chunks.extend([
        f'--{boundary}\r\n'.encode(),
        f'Content-Disposition: form-data; name="file"; filename="recording{ext}"\r\n'.encode(),
        f'Content-Type: {mime_type}\r\n\r\n'.encode(),
        audio, b'\r\n', f'--{boundary}--\r\n'.encode()
    ])
    request = urllib.request.Request(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        data=b''.join(chunks),
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'User-Agent': 'Rex-AI/1.0',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')[:1000]
        raise RuntimeError(f'Groq Whisper request failed ({exc.code}): {detail}') from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f'Could not reach Groq Whisper: {exc.reason}') from exc
    text = str(payload.get('text') or '').strip()
    if not text:
        raise RuntimeError('Groq Whisper returned an empty transcript.')
    return text


def synthesize_speech(text, api_key=None):
    api_key = _api_key('gemini', api_key)
    text = str(text or '').strip()
    if not text:
        raise ValueError('There is no text to synthesize.')
    if len(text) > 10000:
        raise ValueError('Text is too long for one TTS request.')

    # Gemini 3.8 TTS expects the transcript itself as the text input.
    # Wrapping it in "Say exactly..." can cause the TTS model to vocalize a
    # generated response instead of the requested transcript (for example,
    # the old Rex build could end up saying "Thank you.").
    models = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview']
    last_error = None
    for model in models:
        url = f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
        payload = {
            'contents': [{'role': 'user', 'parts': [{
                'text': text,
                'speech_metadata': {'style': 'natural, clear, conversational'}
            }]}],
            'generationConfig': {
                'responseModalities': ['AUDIO'],
                'responseFormat': {'audio': {'mimeType': 'AUDIO_L16', 'sampleRate': 24000}},
                'speechConfig': {
                    'voiceConfig': {'prebuiltVoiceConfig': {'voiceName': 'Kore'}},
                    'languageCode': 'en-US',
                },
            },
        }
        request = urllib.request.Request(
            url, data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'x-goog-api-key': api_key, 'User-Agent': 'Rex-AI/1.0'},
            method='POST'
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')[:1200]
            last_error = RuntimeError(f'Gemini TTS request failed ({exc.code}): {detail}')
            if exc.code in (400, 403, 404) and model != models[-1]:
                continue
            raise last_error from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f'Could not reach Gemini TTS: {exc.reason}') from exc

        parts = (((result.get('candidates') or [{}])[0].get('content') or {}).get('parts') or [])
        audio_part = next((part.get('inlineData') or part.get('inline_data') for part in parts if part.get('inlineData') or part.get('inline_data')), None)
        if not audio_part or not audio_part.get('data'):
            raise RuntimeError(f'Gemini TTS model {model} returned no audio data.')
        return {'audio': audio_part['data'], 'mimeType': audio_part.get('mimeType') or 'audio/L16;rate=24000'}

    raise last_error or RuntimeError('Gemini TTS failed.')

