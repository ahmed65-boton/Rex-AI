"""Rex AI backend launcher.

Keeps the historical ``python server.py`` entry point and re-exports public
helpers used by existing tests and integrations. Backend implementation lives
in ``rex_server`` modules.
"""
import asyncio

from rex_server import remote_access
from rex_server.api_keys import (
    APP_DIR, API_KEY_FILENAMES, GEMINI_FALLBACK_KEY,
    parse_api_keys, find_api_key_file, _api_key,
)
from rex_server.workspace import (
    get_workspace, _windows_drives, _normalize_browse_path, browse_workspace,
    select_workspace, create_workspace_folder, read_workspace_file,
    write_workspace_file,
)
from rex_server import workspace as _workspace
from rex_server.terminal import is_blocked_command, execute_terminal, get_shell, build_shell_argv
from rex_server.media import generate_image, transcribe_audio, synthesize_speech
from rex_server.agent import run_antigravity
from rex_server.bridge import handle_message
from rex_server.http_server import HTTP_HOST, HTTP_PORT, RexHTTPHandler, start_http_server
from rex_server.websocket_server import handle_client


def safe_workspace_path(relative_path):
    """Compatibility wrapper using this module’s current workspace getter."""
    return _workspace.safe_workspace_path(relative_path, get_workspace)


async def main():
    print("=" * 60)
    print("  Hybrid Agent Engine — Terminal / Workspace Bridge")
    print("  Listening on ws://127.0.0.1:8765")
    print(f"  Workspace: {get_workspace()}")
    api_file, _ = find_api_key_file()
    print(f"  API keys:  {api_file or 'built-in / IndexedDB'}")
    print("=" * 60)
    http_server = start_http_server()
    import websockets
    try:
        async with websockets.serve(handle_client, "127.0.0.1", 8765):
            await asyncio.Future()
    finally:
        remote_access.stop_remote_access()
        http_server.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nRex stopped.")
