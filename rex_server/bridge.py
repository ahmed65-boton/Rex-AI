"""WebSocket/HTTP bridge action router for Rex AI."""
import asyncio
import os

from . import remote_access
from .api_keys import find_api_key_file
from .workspace import (
    get_workspace, browse_workspace, create_workspace_folder, select_workspace,
    read_workspace_file, write_workspace_file,
)
from .media import generate_image, transcribe_audio, synthesize_speech
from .agent import run_antigravity
from .terminal import execute_terminal


async def handle_message(data):
    action = data.get("action") or data.get("type") or "terminal"

    if action == "remote_access_start":
        try:
            return await asyncio.to_thread(remote_access.start_remote_access)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "remote_access_stop":
        return await asyncio.to_thread(remote_access.stop_remote_access)

    if action == "remote_access_status":
        return remote_access.remote_access_status()

    if action == "ping":
        return {"ok": True, "workspace": get_workspace()}

    if action in {"pick_workspace", "choose_workspace"}:
        return await asyncio.to_thread(browse_workspace, data.get("path", ""))

    if action == "workspace_browse":
        try:
            return await asyncio.to_thread(browse_workspace, data.get("path", ""))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "workspace_mkdir":
        try:
            return await asyncio.to_thread(create_workspace_folder, data.get("path", ""), data.get("name", ""))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "workspace_select":
        try:
            workspace = await asyncio.to_thread(select_workspace, data.get("path", ""))
            return {
                "ok": True,
                "workspace": workspace,
                "workspaceName": os.path.basename(workspace.rstrip(os.sep)) or workspace,
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "load_api_keys":
        filename, keys = await asyncio.to_thread(find_api_key_file)
        return {"ok": True, "fileName": filename, "keys": keys}

    if action == "read_file":
        try:
            return {"ok": True, "content": await asyncio.to_thread(read_workspace_file, data.get("path", ""))}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "generate_image":
        try:
            result = await asyncio.to_thread(generate_image, data.get("prompt", ""), data.get("model", "flux"), data.get("width", 1024), data.get("height", 1024))
            return {"ok": True, **result}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "stt":
        try:
            text = await asyncio.to_thread(transcribe_audio, data.get("audio", ""), data.get("mimeType", "audio/webm"))
            return {"ok": True, "text": text}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "tts":
        try:
            result = await asyncio.to_thread(synthesize_speech, data.get("text", ""), data.get("apiKey"))
            return {"ok": True, **result}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "write_file":
        try:
            await asyncio.to_thread(write_workspace_file, data.get("path", ""), data.get("content", ""))
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "antigravity":
        try:
            return await run_antigravity(data.get("prompt", ""), data.get("apiKey"))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    if action == "terminal":
        return await execute_terminal(data.get("command", ""))

    if action == "write_file_b64":
        try:
            import base64
            raw = base64.b64decode(str(data.get("content", "")))
            from .workspace import safe_workspace_path
            path = safe_workspace_path(data.get("path", ""))
            # Use module-level `os` — a local `import os` here made Python treat
            # `os` as local for the whole function and broke workspace_select.
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, "wb") as f:
                f.write(raw)
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    return {"error": f"Unknown bridge action: {action}"}

