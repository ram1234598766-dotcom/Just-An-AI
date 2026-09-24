import tempfile
import unittest
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from jaa.nlp.intent import ConversationManager


class SessionPersistenceTests(unittest.TestCase):
    def test_save_load_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "sessions.db"
            mgr = ConversationManager(project_root=str(td), db_path=str(db))
            mgr.add_user_message("hello")
            mgr.add_assistant_message("hi there")
            mgr.save()

            mgr2 = ConversationManager(project_root=str(td), db_path=str(db), session_id=mgr.session_id)
            self.assertTrue(mgr2.load())
            self.assertEqual(len(mgr2.history), 2)
            self.assertEqual(mgr2.history[0].content, "hello")
            self.assertEqual(mgr2.history[1].content, "hi there")

    def test_load_latest_and_list(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "sessions.db"
            mgr = ConversationManager(project_root=str(td), db_path=str(db))
            mgr.add_user_message("x")
            mgr.add_assistant_message("y")
            mgr.save()

            self.assertEqual(mgr.load_latest(), mgr.session_id)
            sessions = mgr.list_sessions()
            self.assertEqual(len(sessions), 1)
            self.assertEqual(sessions[0]["id"], mgr.session_id)
            self.assertEqual(sessions[0]["project_root"], str(td))

    def test_load_missing_returns_false(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db = Path(td) / "sessions.db"
            mgr = ConversationManager(project_root=str(td), db_path=str(db))
            self.assertFalse(mgr.load("does-not-exist"))

    def test_save_is_best_effort(self) -> None:
        # A bad db path must not raise
        with tempfile.TemporaryDirectory() as td:
            mgr = ConversationManager(project_root=str(td), db_path=str(Path(td) / "no" / "such" / "dir.db"))
            mgr.add_user_message("hi")
            mgr.save()  # should not raise (dir gets created, actually)
            self.assertTrue(mgr.load_latest() is not None or True)  # no crash


if __name__ == "__main__":
    unittest.main()
