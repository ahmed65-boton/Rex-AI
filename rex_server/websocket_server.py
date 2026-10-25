"""WebSocket transport for the Rex AI local bridge."""
import json

from .bridge import handle_message


async def handle_client(websocket):
    async for message in websocket:
        try:
            data = json.loads(message)
            result = await handle_message(data)
        except json.JSONDecodeError:
            result = {"error": "Invalid JSON payload."}
        except Exception as exc:
            result = {"error": str(exc)}
        if isinstance(data, dict) and data.get("requestId"):
            result["requestId"] = data["requestId"]
        await websocket.send(json.dumps(result))

