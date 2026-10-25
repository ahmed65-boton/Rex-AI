"""Optional Antigravity coding-agent integration."""
import os
from .api_keys import find_api_key_file
from .workspace import get_workspace


async def run_antigravity(prompt, api_key=None):
    """Run Google's local Antigravity agent against Rex's selected workspace."""
    workspace = get_workspace()
    if not workspace or not os.path.isdir(workspace):
        raise RuntimeError('Attach a workspace before using Antigravity.')
    key = str(api_key or '').strip()
    if not key:
        _, keys = find_api_key_file()
        key = str(keys.get('antigravity') or '').strip()
    if not key or key.startswith('YOUR_') or key.startswith('REPLACE---ME'):
        raise RuntimeError('Antigravity API key is not configured. Add Antigravity: ... to API Keys.txt or Rex Settings.')

    try:
        from google.antigravity import Agent, LocalAgentConfig
        from google.antigravity.hooks import policy
    except ImportError as exc:
        raise RuntimeError('Antigravity SDK is not installed. Run: python -m pip install -r requirements.txt') from exc

    old_key = os.environ.get('GEMINI_API_KEY')
    os.environ['GEMINI_API_KEY'] = key
    try:
        config = LocalAgentConfig(
            workspaces=[workspace],
            policies=[policy.allow_all()],
            system_instructions=(
                'You are Antigravity inside Rex AI. Work directly in the selected Rex workspace. '
                'You are a full autonomous coding agent: inspect files, edit files, run commands, use web tools, '
                'and complete multi-step tasks instead of merely explaining them. Keep all file work scoped to the '
                'provided workspace. Be concise in your final response.'
            ),
        )
        async with Agent(config) as agent:
            response = await agent.chat(str(prompt or ''))
            return {'ok': True, 'text': await response.text(), 'workspace': workspace}
    finally:
        if old_key is None:
            os.environ.pop('GEMINI_API_KEY', None)
        else:
            os.environ['GEMINI_API_KEY'] = old_key

