"""
Memory module for J.A.A.

Provides vector storage, session memory, knowledge base,
codebase indexing, and context retrieval.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sqlite3
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    import chromadb
    from chromadb.config import Settings as ChromaSettings
except ImportError:  # pragma: no cover - fallback for lightweight environments
    chromadb = None
    ChromaSettings = None

try:
    from sentence_transformers import SentenceTransformer
except ImportError:  # pragma: no cover - fallback for lightweight environments
    SentenceTransformer = None

from jaa.config.settings import MemorySettings, get_settings

logger = logging.getLogger(__name__)


@dataclass
class MemoryEntry:
    """A single memory entry."""
    id: str
    content: str
    metadata: dict[str, Any]
    embedding: list[float] | None = None
    timestamp: float = field(default_factory=time.time)
    memory_type: str = "general"  # general, code, conversation, fact, preference


@dataclass
class RetrievalResult:
    """Result of memory retrieval."""
    entry: MemoryEntry
    score: float
    rank: int


class VectorStore(ABC):
    """Abstract vector store interface."""

    @abstractmethod
    async def add(self, entries: list[MemoryEntry]) -> None:
        """Add entries to store."""
        pass

    @abstractmethod
    async def search(
        self,
        query_embedding: list[float],
        top_k: int = 10,
        filter_metadata: dict | None = None,
    ) -> list[RetrievalResult]:
        """Search for similar entries."""
        pass

    @abstractmethod
    async def search_text(
        self,
        query: str,
        top_k: int = 10,
        filter_metadata: dict | None = None,
    ) -> list[RetrievalResult]:
        """Search using a text query (embedded internally)."""
        pass

    @abstractmethod
    async def delete(self, ids: list[str]) -> None:
        """Delete entries by ID."""
        pass

    @abstractmethod
    async def get(self, ids: list[str]) -> list[MemoryEntry]:
        """Get entries by ID."""
        pass

    @abstractmethod
    async def count(self) -> int:
        """Get total entry count."""
        pass


class ChromaVectorStore(VectorStore):
    """ChromaDB vector store implementation."""

    def __init__(self, settings: MemorySettings | None = None):
        self.settings = settings or get_settings().memory
        self._client: chromadb.Client | None = None
        self._collection = None
        self._embedding_model: SentenceTransformer | None = None
        self._entries: list[MemoryEntry] = []
        self._use_fallback = False

    async def _init_client(self) -> None:
        """Initialize ChromaDB client."""
        if self._client is not None:
            return

        if chromadb is None:
            self._client = None
            self._collection = None
            self._embedding_model = None
            self._use_fallback = True
            logger.warning("ChromaDB and sentence-transformers are unavailable; using in-memory fallbacks")
            return

        self._client = chromadb.PersistentClient(
            path=self.settings.chromadb_path,
            settings=ChromaSettings(
                anonymized_telemetry=False,
                allow_reset=True,
            ),
        )

        self._collection = self._client.get_or_create_collection(
            name=self.settings.collection_name,
            metadata={"hnsw:space": "cosine"},
        )

        # Load embedding model if available
        if SentenceTransformer is not None:
            self._embedding_model = SentenceTransformer(
                self.settings.embedding_model.replace(":latest", ""),
                device="cpu",
            )
        logger.info(f"ChromaDB initialized at {self.settings.chromadb_path}")

    def _embed(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings."""
        if self._embedding_model is None:
            return [[0.0] * 3 for _ in texts]
        embeddings = self._embedding_model.encode(texts, convert_to_tensor=False)
        return embeddings.tolist()

    async def embed_query(self, text: str) -> list[float]:
        """Embed a single query string."""
        await self._init_client()
        return (await asyncio.to_thread(self._embed, [text]))[0]

    async def add(self, entries: list[MemoryEntry]) -> None:
        await self._init_client()

        if not entries:
            return

        if self._use_fallback:
            for entry in entries:
                if entry.embedding is None:
                    entry.embedding = [0.0] * 3
                self._entries.append(entry)
            logger.debug(f"Added {len(entries)} entries to in-memory vector store")
            return

        ids = [e.id for e in entries]
        documents = [e.content for e in entries]
        metadatas = [e.metadata for e in entries]
        if all(e.embedding is not None for e in entries):
            embeddings = [e.embedding for e in entries]
        else:
            embeddings = await asyncio.to_thread(self._embed, documents)

        # Update entries with embeddings
        for i, entry in enumerate(entries):
            if entry.embedding is None:
                entry.embedding = embeddings[i]

        self._collection.upsert(
            ids=ids,
            documents=documents,
            metadatas=metadatas,
            embeddings=embeddings,
        )
        logger.debug(f"Added {len(entries)} entries to vector store")

    async def search(
        self,
        query_embedding: list[float],
        top_k: int = 10,
        filter_metadata: dict | None = None,
    ) -> list[RetrievalResult]:
        await self._init_client()

        if self._use_fallback:
            results = []
            for rank, entry in enumerate(self._entries[:top_k]):
                results.append(RetrievalResult(
                    entry=entry,
                    score=1.0,
                    rank=rank,
                ))
            return results

        count = self._collection.count()
        if count == 0:
            return []

        results = self._collection.query(
            query_embeddings=[query_embedding],
            n_results=min(top_k, count),
            where=filter_metadata,
            include=["documents", "metadatas", "distances"],
        )

        retrieval_results = []
        if results["ids"] and results["ids"][0]:
            for rank, (id_, doc, meta, dist) in enumerate(zip(
                results["ids"][0],
                results["documents"][0],
                results["metadatas"][0],
                results["distances"][0],
            )):
                entry = MemoryEntry(
                    id=id_,
                    content=doc,
                    metadata=meta or {},
                )
                # Convert distance to similarity score (cosine)
                score = 1.0 - dist
                retrieval_results.append(RetrievalResult(
                    entry=entry,
                    score=score,
                    rank=rank,
                ))

        return retrieval_results

    async def search_text(
        self,
        query: str,
        top_k: int = 10,
        filter_metadata: dict | None = None,
    ) -> list[RetrievalResult]:
        """Search using a text query (embedded internally)."""
        query_embedding = await self.embed_query(query)
        return await self.search(query_embedding, top_k, filter_metadata)

    async def delete(self, ids: list[str]) -> None:
        await self._init_client()
        if self._use_fallback:
            self._entries = [e for e in self._entries if e.id not in ids]
            return
        self._collection.delete(ids=ids)

    async def get(self, ids: list[str]) -> list[MemoryEntry]:
        await self._init_client()
        if self._use_fallback:
            return [e for e in self._entries if e.id in ids]
        results = self._collection.get(ids=ids, include=["documents", "metadatas", "embeddings"])

        entries = []
        if results["ids"]:
            for id_, doc, meta, emb in zip(
                results["ids"],
                results["documents"],
                results["metadatas"],
                results["embeddings"],
            ):
                entries.append(MemoryEntry(
                    id=id_,
                    content=doc,
                    metadata=meta,
                    embedding=emb,
                ))
        return entries

    async def count(self) -> int:
        await self._init_client()
        if self._use_fallback:
            return len(self._entries)
        return self._collection.count()


class SessionMemory:
    """Short-term conversation memory."""

    def __init__(self, settings: MemorySettings | None = None):
        self.settings = settings or get_settings().memory
        self._turns: list[dict] = []
        self._max_turns = self.settings.short_term_turns

    def add_turn(self, role: str, content: str, metadata: dict | None = None) -> None:
        """Add a conversation turn."""
        turn = {
            "role": role,
            "content": content,
            "timestamp": time.time(),
            "metadata": metadata or {},
        }
        self._turns.append(turn)

        # Trim if exceeds max
        if len(self._turns) > self._max_turns * 2:  # *2 for user+assistant pairs
            self._turns = self._turns[-(self._max_turns * 2):]

    def get_recent(self, num_turns: int | None = None) -> list[dict]:
        """Get recent conversation turns."""
        turns = num_turns or self._max_turns
        return self._turns[-(turns * 2):]

    def get_context_string(self, max_tokens: int = 4000) -> str:
        """Get conversation context as formatted string."""
        turns = self.get_recent()
        context_parts = []

        for turn in turns:
            prefix = "User" if turn["role"] == "user" else "Assistant"
            context_parts.append(f"{prefix}: {turn['content']}")

        context = "\n\n".join(context_parts)

        # Rough token estimation (4 chars ≈ 1 token)
        if len(context) > max_tokens * 4:
            # Truncate from start
            context = context[-(max_tokens * 4):]
            # Find first complete turn
            first_newline = context.find("\n\n")
            if first_newline > 0:
                context = context[first_newline + 2:]

        return context

    def clear(self) -> None:
        """Clear session memory."""
        self._turns.clear()


class KnowledgeBase:
    """Long-term knowledge storage for facts, preferences, learned skills."""

    def __init__(self, vector_store: VectorStore):
        self.vector_store = vector_store
        self._fact_cache: dict[str, MemoryEntry] = {}

    async def add_fact(self, fact: str, category: str, confidence: float = 1.0, source: str = "user") -> str:
        """Add a fact to knowledge base."""
        entry_id = hashlib.sha256(fact.encode()).hexdigest()[:16]
        entry = MemoryEntry(
            id=entry_id,
            content=fact,
            metadata={
                "type": "fact",
                "category": category,
                "confidence": confidence,
                "source": source,
                "created_at": time.time(),
            },
            memory_type="fact",
        )
        await self.vector_store.add([entry])
        return entry_id

    async def add_preference(self, key: str, value: Any, context: str = "") -> str:
        """Add user preference."""
        content = f"User prefers {key}: {value}"
        if context:
            content += f" (context: {context})"

        entry_id = hashlib.sha256(f"pref:{key}".encode()).hexdigest()[:16]
        entry = MemoryEntry(
            id=entry_id,
            content=content,
            metadata={
                "type": "preference",
                "key": key,
                "value": str(value),
                "context": context,
            },
            memory_type="preference",
        )
        await self.vector_store.add([entry])
        return entry_id

    async def get_preference(self, key: str) -> Any | None:
        """Get user preference."""
        results = await self.vector_store.search_text(
            query=f"User prefers {key}",
            top_k=5,
            filter_metadata={"$and": [{"type": "preference"}, {"key": key}]},
        )
        if results:
            raw = results[0].entry.metadata.get("value")
            if raw is None:
                return None
            try:
                return json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return raw
        return None

    async def search_facts(self, query: str, top_k: int = 5) -> list[RetrievalResult]:
        """Search facts."""
        try:
            return await self.vector_store.search_text(
                query=query,
                top_k=top_k,
                filter_metadata={"type": "fact"},
            )
        except Exception as e:
            logger.warning(f"Fact search failed: {e}")
            return []

    async def learn_from_interaction(self, user_input: str, assistant_response: str, outcome: str) -> None:
        """Learn from interaction outcome."""
        fact = f"When user said '{user_input[:100]}', responding with '{assistant_response[:100]}' led to {outcome}"
        await self.add_fact(fact, "interaction_pattern", confidence=0.7, source="learning")


class CodebaseIndexer:
    """Index and search codebase."""

    def __init__(self, vector_store: VectorStore, project_root: Path):
        self.vector_store = vector_store
        self.project_root = project_root
        self._indexed_files: set[str] = set()
        self._file_hashes: dict[str, str] = {}

    def _should_index(self, file_path: Path) -> bool:
        """Check if file should be indexed."""
        excludes = [
            ".git", "__pycache__", "node_modules", ".venv", "venv",
            "dist", "build", ".next", ".nuxt", "target", "bin", "obj",
            "*.pyc", "*.pyo", "*.pyd", "*.so", "*.dll", "*.exe",
            "*.min.js", "*.map", "*.lock",
        ]

        rel_path = file_path.relative_to(self.project_root)
        path_str = str(rel_path)

        for exclude in excludes:
            if exclude.startswith("*"):
                if path_str.endswith(exclude[1:]):
                    return False
            elif exclude in path_str.split("/") or exclude in path_str.split("\\"):
                return False

        # Only index text files
        text_extensions = {
            ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".yaml", ".yml",
            ".toml", ".ini", ".cfg", ".md", ".txt", ".rst", ".html", ".css",
            ".scss", ".sass", ".less", ".sql", ".sh", ".bat", ".ps1",
            ".rs", ".go", ".java", ".kt", ".swift", ".cpp", ".c", ".h",
            ".cs", ".vb", ".php", ".rb", ".pl", ".lua", ".r", ".m",
            ".dart", ".zig", ".nim", ".jl", ".ex", ".exs", ".erl",
            ".dockerfile", ".gitignore", ".env", ".editorconfig",
        }

        return file_path.suffix.lower() in text_extensions

    def _hash_file(self, file_path: Path) -> str:
        """Compute file hash."""
        try:
            content = file_path.read_bytes()
            return hashlib.sha256(content).hexdigest()
        except Exception:
            return ""

    async def index_project(self, force: bool = False) -> dict[str, int]:
        """Index entire project."""
        stats = {"indexed": 0, "skipped": 0, "errors": 0}

        for file_path in self.project_root.rglob("*"):
            if not file_path.is_file():
                continue

            if not self._should_index(file_path):
                stats["skipped"] += 1
                continue

            rel_path = str(file_path.relative_to(self.project_root))
            file_hash = self._hash_file(file_path)

            if not force and rel_path in self._file_hashes and self._file_hashes[rel_path] == file_hash:
                stats["skipped"] += 1
                continue

            try:
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                if not content.strip():
                    stats["skipped"] += 1
                    continue

                # Chunk large files and add in one batch
                chunks = self._chunk_content(content, rel_path)
                entries = []
                for i, chunk in enumerate(chunks):
                    entry_id = hashlib.sha256(f"{rel_path}:{i}".encode()).hexdigest()[:16]
                    entries.append(MemoryEntry(
                        id=entry_id,
                        content=chunk,
                        metadata={
                            "type": "code",
                            "file": rel_path,
                            "chunk": i,
                            "language": self._detect_language(file_path),
                        },
                        memory_type="code",
                    ))
                await self.vector_store.add(entries)

                self._file_hashes[rel_path] = file_hash
                stats["indexed"] += 1

            except Exception as e:
                logger.error(f"Failed to index {rel_path}: {e}")
                stats["errors"] += 1

        logger.info(f"Codebase indexing complete: {stats}")
        return stats

    def _chunk_content(self, content: str, file_path: str, max_chunk_size: int = 2000) -> list[str]:
        """Split content into chunks."""
        lines = content.split("\n")
        chunks = []
        current_chunk = []
        current_size = 0

        for line in lines:
            line_size = len(line)
            if current_size + line_size > max_chunk_size and current_chunk:
                chunks.append("\n".join(current_chunk))
                current_chunk = [line]
                current_size = line_size
            else:
                current_chunk.append(line)
                current_size += line_size

        if current_chunk:
            chunks.append("\n".join(current_chunk))

        return chunks

    def _detect_language(self, file_path: Path) -> str:
        """Detect programming language from extension."""
        ext_map = {
            ".py": "python", ".js": "javascript", ".ts": "typescript",
            ".jsx": "javascript", ".tsx": "typescript", ".json": "json",
            ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
            ".md": "markdown", ".html": "html", ".css": "css",
            ".sql": "sql", ".sh": "bash", ".bat": "batch",
            ".rs": "rust", ".go": "go", ".java": "java",
            ".cpp": "cpp", ".c": "c", ".h": "c",
            ".cs": "csharp", ".php": "php", ".rb": "ruby",
        }
        return ext_map.get(file_path.suffix.lower(), "text")

    async def search_code(self, query: str, top_k: int = 10) -> list[RetrievalResult]:
        """Search indexed code."""
        try:
            return await self.vector_store.search_text(
                query=query,
                top_k=top_k,
                filter_metadata={"type": "code"},
            )
        except Exception as e:
            logger.warning(f"Code search failed: {e}")
            return []

    def get_stats(self) -> dict[str, int]:
        """Get indexing stats."""
        return {
            "indexed_files": len(self._file_hashes),
        }


class ContextRetriever:
    """Hybrid context retrieval combining multiple sources."""

    def __init__(
        self,
        vector_store: VectorStore,
        session_memory: SessionMemory,
        knowledge_base: KnowledgeBase,
        codebase_indexer: CodebaseIndexer | None = None,
    ):
        self.vector_store = vector_store
        self.session_memory = session_memory
        self.knowledge_base = knowledge_base
        self.codebase_indexer = codebase_indexer
        self._settings = get_settings().memory

    async def retrieve(
        self,
        query: str,
        context_types: list[str] | None = None,
        top_k: int = 5,
    ) -> dict[str, list[RetrievalResult]]:
        """Retrieve relevant context from all sources."""
        context_types = context_types or ["conversation", "knowledge", "codebase"]
        results = {}

        # Session memory (recent conversation)
        if "conversation" in context_types:
            session_results = await self._retrieve_session(query, top_k)
            results["conversation"] = session_results

        # Knowledge base
        if "knowledge" in context_types:
            kb_results = await self.knowledge_base.search_facts(query, top_k)
            results["knowledge"] = kb_results

        # Codebase
        if "codebase" in context_types and self.codebase_indexer:
            code_results = await self.codebase_indexer.search_code(query, top_k)
            results["codebase"] = code_results

        # Vector store (general memory)
        if "memory" in context_types:
            try:
                memory_results = await self.vector_store.search_text(query, top_k)
            except Exception as e:
                logger.warning(f"Memory search failed: {e}")
                memory_results = []
            results["memory"] = memory_results

        return results

    async def _retrieve_session(self, query: str, top_k: int) -> list[RetrievalResult]:
        """Retrieve from session memory using simple text matching."""
        turns = self.session_memory.get_recent(top_k)
        results = []

        query_lower = query.lower()
        for i, turn in enumerate(turns):
            if query_lower in turn["content"].lower():
                entry = MemoryEntry(
                    id=f"session_{i}",
                    content=f"{turn['role']}: {turn['content']}",
                    metadata={"role": turn["role"], "timestamp": turn["timestamp"]},
                    memory_type="conversation",
                )
                results.append(RetrievalResult(entry=entry, score=0.8, rank=i))

        return results

    def build_context_prompt(
        self,
        query: str,
        retrieval_results: dict[str, list[RetrievalResult]],
        max_tokens: int = 8000,
    ) -> str:
        """Build context prompt for LLM."""
        sections = []

        # Conversation context
        if "conversation" in retrieval_results and retrieval_results["conversation"]:
            sections.append("=== Recent Conversation ===")
            for result in retrieval_results["conversation"][:3]:
                sections.append(result.entry.content)

        # Knowledge/facts
        if "knowledge" in retrieval_results and retrieval_results["knowledge"]:
            sections.append("\n=== Relevant Facts ===")
            for result in retrieval_results["knowledge"][:3]:
                sections.append(f"- {result.entry.content}")

        # Codebase context
        if "codebase" in retrieval_results and retrieval_results["codebase"]:
            sections.append("\n=== Relevant Code ===")
            for result in retrieval_results["codebase"][:3]:
                meta = result.entry.metadata
                sections.append(f"File: {meta.get('file', 'unknown')}\n{result.entry.content[:1500]}")

        # General memory
        if "memory" in retrieval_results and retrieval_results["memory"]:
            sections.append("\n=== Related Memories ===")
            for result in retrieval_results["memory"][:3]:
                sections.append(f"- {result.entry.content[:500]}")

        context = "\n".join(sections)

        # Truncate if too long
        if len(context) > max_tokens * 4:
            context = context[:max_tokens * 4] + "\n...[truncated]"

        return context


class MemoryManager:
    """High-level memory management."""

    def __init__(self, project_root: Path | None = None):
        self.settings = get_settings().memory
        self.project_root = project_root or Path.cwd()

        # Initialize components
        self.vector_store = ChromaVectorStore(self.settings)
        self.session_memory = SessionMemory(self.settings)
        self.knowledge_base = KnowledgeBase(self.vector_store)
        self.codebase_indexer = CodebaseIndexer(self.vector_store, self.project_root)
        self.context_retriever = ContextRetriever(
            self.vector_store,
            self.session_memory,
            self.knowledge_base,
            self.codebase_indexer,
        )

    async def initialize(self) -> None:
        """Initialize all memory components."""
        await self.vector_store._init_client()
        logger.info("Memory system initialized")

    async def add_conversation_turn(self, role: str, content: str, metadata: dict | None = None) -> None:
        """Add conversation turn to session memory."""
        self.session_memory.add_turn(role, content, metadata)

        # Also store in long-term memory for important exchanges
        if role == "assistant" and len(content) > 100:
            entry = MemoryEntry(
                id=hashlib.sha256(f"{role}:{content}:{time.time()}".encode()).hexdigest()[:16],
                content=content,
                metadata={"role": role, **(metadata or {})},
                memory_type="conversation",
            )
            await self.vector_store.add([entry])

    async def learn_fact(self, fact: str, category: str = "general") -> str:
        """Learn a new fact."""
        return await self.knowledge_base.add_fact(fact, category)

    async def set_preference(self, key: str, value: Any, context: str = "") -> str:
        """Set user preference."""
        return await self.knowledge_base.add_preference(key, value, context)

    async def get_preference(self, key: str) -> Any | None:
        """Get user preference."""
        return await self.knowledge_base.get_preference(key)

    async def index_codebase(self, force: bool = False) -> dict[str, int]:
        """Index project codebase."""
        return await self.codebase_indexer.index_project(force=force)

    async def search(self, query: str, context_types: list[str] | None = None) -> dict[str, list[RetrievalResult]]:
        """Search across all memory sources."""
        return await self.context_retriever.retrieve(query, context_types)

    async def build_context(self, query: str) -> str:
        """Build context prompt for LLM."""
        try:
            results = await self.search(query)
            return self.context_retriever.build_context_prompt(query, results)
        except Exception as e:
            logger.warning(f"Failed to build memory context: {e}")
            return ""

    def get_stats(self) -> dict[str, Any]:
        """Get memory statistics."""
        return {
            "session_turns": len(self.session_memory._turns),
            "indexed_files": len(self.codebase_indexer._file_hashes),
            "chromadb_path": self.settings.chromadb_path,
        }

    def get_session_context(self) -> str:
        """Get current session context."""
        return self.session_memory.get_context_string()