import unittest

from jaa.memory import ChromaVectorStore, MemoryEntry


class MemoryFallbackTests(unittest.TestCase):
    def test_chromadb_fallback_works_without_dependency(self) -> None:
        import jaa.memory as memory_module
        import sys

        actual_memory = sys.modules.get("memory") or memory_module
        original_chromadb = actual_memory.chromadb
        original_settings = actual_memory.ChromaSettings
        actual_memory.chromadb = None
        actual_memory.ChromaSettings = None

        try:
            store = ChromaVectorStore()
            import asyncio

            asyncio.run(store._init_client())
            asyncio.run(store.add([MemoryEntry(id="1", content="hello world", metadata={})]))
            self.assertEqual(asyncio.run(store.count()), 1)
            results = asyncio.run(store.search_text("hello", top_k=5))
            self.assertTrue(results)
        finally:
            actual_memory.chromadb = original_chromadb
            actual_memory.ChromaSettings = original_settings


if __name__ == "__main__":
    unittest.main()
