import os
import tempfile
import unittest
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from jaa.config.keys import mask_key, read_user_env, remove_user_env, user_env_file, write_user_env


class KeyFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._old_userprofile = os.environ.get("USERPROFILE")
        self._old_home = os.environ.get("HOME")
        os.environ["USERPROFILE"] = self._tmp.name
        os.environ["HOME"] = self._tmp.name

    def tearDown(self) -> None:
        import pathlib

        if hasattr(self, "_orig_home"):
            pathlib.Path.home = self._orig_home
        for k in ("USERPROFILE", "HOME"):
            os.environ.pop(k, None)
        self._tmp.cleanup()

    def _set_home(self) -> None:
        # user_env_file uses Path.home(); monkeypatch to temp dir
        import pathlib

        self._orig_home = pathlib.Path.home
        temp = Path(self._tmp.name)
        pathlib.Path.home = classmethod(lambda cls: temp)

    def test_write_read_remove_roundtrip(self) -> None:
        self._set_home()
        path = write_user_env({"JAA_LLM_OPENROUTER_API_KEY": "sk-or-test-123"})
        self.assertEqual(path, user_env_file())
        self.assertTrue(path.exists())
        env = read_user_env()
        self.assertEqual(env["JAA_LLM_OPENROUTER_API_KEY"], "sk-or-test-123")

        # preserves unrelated lines
        path.write_text("# comment\nOTHER=keep\n", encoding="utf-8")
        write_user_env({"JAA_LLM_ANTHROPIC_API_KEY": "sk-ant-test"})
        env = read_user_env()
        self.assertEqual(env["OTHER"], "keep")
        self.assertEqual(env["JAA_LLM_ANTHROPIC_API_KEY"], "sk-ant-test")

        remove_user_env(["JAA_LLM_ANTHROPIC_API_KEY"])
        env = read_user_env()
        self.assertNotIn("JAA_LLM_ANTHROPIC_API_KEY", env)
        self.assertEqual(env["OTHER"], "keep")

    def test_mask_key(self) -> None:
        self.assertEqual(mask_key("sk-or-v1-abcdefghijklmnopqrstuvwxyz"), "sk-or-v1...wxyz")
        self.assertEqual(mask_key("short"), "*****")
        self.assertEqual(mask_key(""), "")

    def test_settings_loads_user_provided_key(self) -> None:
        """The user's own ~/.jaa/.env key is what JAA loads."""
        self._set_home()
        write_user_env({"JAA_LLM_OPENROUTER_API_KEY": "sk-or-user-abc"})

        import jaa.config.settings as settings_mod

        old_value = os.environ.get("JAA_LLM_OPENROUTER_API_KEY")
        try:
            settings_mod._settings = None  # force reload
            settings_mod.load_env_files()
            s = settings_mod.Settings()
            self.assertEqual(s.llm.openrouter_api_key, "sk-or-user-abc")
        finally:
            # Don't leak the loaded env var into other tests
            if old_value is None:
                os.environ.pop("JAA_LLM_OPENROUTER_API_KEY", None)
            else:
                os.environ["JAA_LLM_OPENROUTER_API_KEY"] = old_value
            settings_mod._settings = None


if __name__ == "__main__":
    unittest.main()
