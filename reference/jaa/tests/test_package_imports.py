import unittest
from pathlib import Path

from jaa.config.settings import get_settings
from jaa.utils import find_project_root, summarize_project, truncate


class PackageImportTests(unittest.TestCase):
    def test_settings_and_package_import(self) -> None:
        settings = get_settings()
        self.assertEqual(settings.app_name, "J.A.A.")
        self.assertTrue(settings.data_dir.exists())

    def test_project_summary_and_helpers(self) -> None:
        project_root = Path(__file__).resolve().parent.parent
        summary = summarize_project(project_root)
        self.assertIn("project", summary.lower())
        self.assertIn("files", summary.lower())

        self.assertEqual(truncate("hello world", 5), "hello...")


if __name__ == "__main__":
    unittest.main()
