import tempfile
import unittest
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from jaa.config.settings import get_settings
from jaa.llm import LLMOrchestrator, ModelType, ProviderType
from jaa.skills import SkillManager, _parse_frontmatter
from jaa.utils import estimate_tokens, trim_history


class ProviderTests(unittest.TestCase):
    def test_openrouter_and_compatible_providers_wire_up(self) -> None:
        settings = get_settings().llm
        settings.openrouter_api_key = "test-key"
        settings.compatible_base_url = "http://localhost:1234/v1"
        settings.compatible_api_key = "lm-studio"

        orch = LLMOrchestrator(settings)
        self.assertIn(ProviderType.OPENROUTER, orch.providers)
        self.assertIn(ProviderType.COMPATIBLE, orch.providers)
        # OpenRouter should appear in the coder provider order
        self.assertIn(ProviderType.OPENROUTER, orch.router.get_provider_order(ModelType.CODER))

    def test_openrouter_not_added_without_key(self) -> None:
        settings = get_settings().llm
        settings.openrouter_api_key = None
        settings.compatible_base_url = None
        orch = LLMOrchestrator(settings)
        self.assertNotIn(ProviderType.OPENROUTER, orch.providers)
        self.assertNotIn(ProviderType.COMPATIBLE, orch.providers)


class TokenBudgetTests(unittest.TestCase):
    def test_estimate_tokens(self) -> None:
        self.assertEqual(estimate_tokens("abcd"), 1)
        self.assertEqual(estimate_tokens(""), 1)  # floor of 1

    def test_trim_history_keeps_system_and_latest(self) -> None:
        msgs = [{"role": "system", "content": "SYS"}] + [
            {"role": "user", "content": "x" * 1000}
        ] * 40 + [{"role": "assistant", "content": "latest"}]

        out = trim_history(msgs, token_budget=4000)
        total = sum(estimate_tokens(str(m.get("content", ""))) for m in out)
        self.assertLessEqual(total, 4000)
        self.assertEqual(out[0]["role"], "system")
        self.assertEqual(out[-1]["role"], "assistant")

    def test_trim_history_noop_when_under_budget(self) -> None:
        msgs = [{"role": "user", "content": "hi"}]
        self.assertEqual(trim_history(msgs, token_budget=1000), msgs)


class SkillsTests(unittest.TestCase):
    def test_parse_frontmatter(self) -> None:
        md = "---\nname: my-skill\ndescription: Does a thing\n---\n\nBody here"
        self.assertEqual(_parse_frontmatter(md), {"name": "my-skill", "description": "Does a thing"})

    def test_parse_frontmatter_missing(self) -> None:
        self.assertEqual(_parse_frontmatter("just a doc"), {})

    def test_skill_manager_empty(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            mgr = SkillManager(skills_dir=Path(td))
            self.assertEqual(mgr.list_installed(), [])
            self.assertEqual(mgr.build_context(), "")

    def test_skill_discovery(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            mgr = SkillManager(skills_dir=Path(td))
            skill_md = Path(td) / "owner__repo" / "SKILL.md"
            skill_md.parent.mkdir(parents=True)
            skill_md.write_text("---\nname: demo\ndescription: A demo skill.\n---\n\nInstructions.")
            skills = mgr.list_installed()
            self.assertEqual(len(skills), 1)
            self.assertEqual(skills[0].name, "demo")
            self.assertIn("demo", mgr.build_context(query="demo"))

    def test_remove(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            mgr = SkillManager(skills_dir=Path(td))
            (Path(td) / "owner__repo").mkdir()
            self.assertTrue(mgr.remove("owner/repo"))
            self.assertFalse(mgr.remove("owner/repo"))


if __name__ == "__main__":
    unittest.main()
