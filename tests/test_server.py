import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from rex_server import api_keys as api_keys_mod
from rex_server.terminal import is_blocked_command, get_shell, build_shell_argv, load_blocked_patterns

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "api_keys_samples.json"
SCHEMA = ROOT / "api_keys_schema.json"


class SchemaTests(unittest.TestCase):
    def test_schema_file_exists_and_has_aliases(self):
        data = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertIn("aliases", data)
        self.assertIsInstance(data["aliases"], dict)
        self.assertIn("groq", data["aliases"])
        self.assertEqual(data["aliases"]["open router"], "openrouter")

    def test_python_loads_same_schema(self):
        aliases = api_keys_mod.load_api_key_aliases(str(SCHEMA))
        data = json.loads(SCHEMA.read_text(encoding="utf-8"))
        expected = {str(k).strip().lower(): v for k, v in data["aliases"].items()}
        self.assertEqual(aliases, expected)


class ParseApiKeysTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        api_keys_mod.load_api_key_aliases(str(SCHEMA))

    def test_fixture_samples(self):
        fixtures = json.loads(FIXTURES.read_text(encoding="utf-8"))
        for sample in fixtures["samples"]:
            with self.subTest(sample=sample["name"]):
                self.assertEqual(
                    server.parse_api_keys(sample["input"]),
                    sample["expected"],
                )

    def test_valid_aliases_and_values_with_colons(self):
        parsed = server.parse_api_keys(
            "Groq: abc123\nOpen Router: key:with:colons\nGemini model: gemini-fast"
        )
        self.assertEqual(parsed["groq"], "abc123")
        self.assertEqual(parsed["openrouter"], "key:with:colons")
        self.assertEqual(parsed["geminiModel"], "gemini-fast")

    def test_empty_input(self):
        self.assertEqual(server.parse_api_keys(""), {})

    def test_unknown_label_is_ignored(self):
        self.assertEqual(server.parse_api_keys("not a provider: value"), {})

    def test_missing_value_can_be_on_next_line(self):
        self.assertEqual(server.parse_api_keys("Groq:\nmy-key"), {"groq": "my-key"})


class SharedParserParityTests(unittest.TestCase):
    """Run the same fixture inputs through the JS parser and compare to Python."""

    def test_js_and_python_agree_on_fixtures(self):
        import subprocess
        import sys

        script = r"""
import { loadApiKeySchema, parseApiKeyText } from './modules/api-keys.js';
import { readFile } from 'node:fs/promises';
await loadApiKeySchema();
const fixtures = JSON.parse(await readFile('./tests/fixtures/api_keys_samples.json', 'utf8'));
const out = {};
for (const s of fixtures.samples) out[s.name] = parseApiKeyText(s.input);
process.stdout.write(JSON.stringify(out));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            self.fail(f"JS parser failed:\n{result.stderr or result.stdout}")
        js_results = json.loads(result.stdout)
        fixtures = json.loads(FIXTURES.read_text(encoding="utf-8"))
        api_keys_mod.load_api_key_aliases(str(SCHEMA))
        for sample in fixtures["samples"]:
            with self.subTest(sample=sample["name"]):
                py = server.parse_api_keys(sample["input"])
                self.assertEqual(js_results[sample["name"]], py)
                self.assertEqual(py, sample["expected"])


class WorkspaceSafetyTests(unittest.TestCase):
    def test_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(server, "get_workspace", return_value=root):
                with self.assertRaises(PermissionError):
                    server.safe_workspace_path("../outside.txt")

    def test_accepts_child_path(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(server, "get_workspace", return_value=root):
                self.assertEqual(
                    server.safe_workspace_path("notes.txt"),
                    os.path.join(root, "notes.txt"),
                )


class BlocklistTests(unittest.TestCase):
    def test_blocks_system_destructive_commands(self):
        for command in (
            "diskpart",
            "bcdedit /deletevalue {default} safeboot",
            "format C:",
            "Clear-Disk 0",
            "rm -rf /",
        ):
            with self.subTest(command=command):
                self.assertTrue(is_blocked_command(command))

    def test_allows_ordinary_commands(self):
        for command in ("python --version", "git status", "ls", "pytest tests"):
            with self.subTest(command=command):
                self.assertFalse(is_blocked_command(command))


if __name__ == "__main__":
    unittest.main()


class ShellAbstractionTests(unittest.TestCase):
    def test_get_shell_returns_path_and_kind(self):
        path, kind = get_shell()
        self.assertIn(kind, ("powershell", "posix"))
        self.assertTrue(path)

    def test_build_shell_argv_posix_or_powershell(self):
        args, kind = build_shell_argv("echo hello")
        self.assertIsNotNone(args)
        self.assertEqual(args[-1], "echo hello")
        if kind == "powershell":
            self.assertIn("-Command", args)
        else:
            self.assertIn("-lc", args)


class SharedBlocklistTests(unittest.TestCase):
    def test_json_file_exists_and_loads(self):
        patterns = load_blocked_patterns()
        self.assertGreaterEqual(len(patterns), 5)
        self.assertTrue(is_blocked_command('diskpart'))
        self.assertTrue(is_blocked_command('rm -rf /'))
        self.assertFalse(is_blocked_command('echo hello'))
