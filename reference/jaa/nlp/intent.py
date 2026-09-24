"""
NLP module for J.A.A.

Provides intent classification, entity extraction, command parsing,
and conversation management.
"""

from __future__ import annotations

import json
import logging
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

try:
    from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
    from langchain_core.prompts import ChatPromptTemplate
except ImportError:  # pragma: no cover - fallback for lightweight environments
    class BaseMessage:
        def __init__(self, content: str = "", **kwargs):
            self.content = content
            self.additional_kwargs = kwargs

    class HumanMessage(BaseMessage):
        pass

    class AIMessage(BaseMessage):
        pass

    class SystemMessage(BaseMessage):
        pass

    class ChatPromptTemplate:
        pass

try:
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover - fallback for lightweight environments
    class BaseModel:  # type: ignore[override]
        pass

    def Field(*args, **kwargs):
        return None

from jaa.config.settings import get_settings
from jaa.llm import LLMOrchestrator, LLMRequest, ModelType

logger = logging.getLogger(__name__)


class IntentCategory(str, Enum):
    """Categories of user intents."""

    # Code intents
    CODE_GENERATE = "code_generate"
    CODE_REFACTOR = "code_refactor"
    CODE_DEBUG = "code_debug"
    CODE_EXPLAIN = "code_explain"
    CODE_TEST = "code_test"
    CODE_REVIEW = "code_review"
    CODE_DOCUMENT = "code_document"
    CODE_SEARCH = "code_search"

    # Desktop intents
    DESKTOP_OPEN = "desktop_open"
    DESKTOP_CLOSE = "desktop_close"
    DESKTOP_SWITCH = "desktop_switch"
    DESKTOP_ARRANGE = "desktop_arrange"
    DESKTOP_SCREENSHOT = "desktop_screenshot"
    DESKTOP_TYPE = "desktop_type"
    DESKTOP_CLICK = "desktop_click"
    DESKTOP_SHORTCUT = "desktop_shortcut"

    # File intents
    FILE_CREATE = "file_create"
    FILE_READ = "file_read"
    FILE_WRITE = "file_write"
    FILE_DELETE = "file_delete"
    FILE_MOVE = "file_move"
    FILE_COPY = "file_copy"
    FILE_SEARCH = "file_search"
    FILE_ORGANIZE = "file_organize"

    # System intents
    SYSTEM_INFO = "system_info"
    SYSTEM_PROCESS = "system_process"
    SYSTEM_NETWORK = "system_network"
    SYSTEM_SETTINGS = "system_settings"

    # Query intents
    QUERY_GENERAL = "query_general"
    QUERY_WEB = "query_web"
    QUERY_MEMORY = "query_memory"

    # Control intents
    CONTROL_STOP = "control_stop"
    CONTROL_PAUSE = "control_pause"
    CONTROL_RESUME = "control_resume"
    CONTROL_REPEAT = "control_repeat"

    # Unknown
    UNKNOWN = "unknown"


class EntityType(str, Enum):
    """Types of entities that can be extracted."""

    # Code entities
    FILE_PATH = "file_path"
    FUNCTION_NAME = "function_name"
    CLASS_NAME = "class_name"
    VARIABLE_NAME = "variable_name"
    MODULE_NAME = "module_name"
    LANGUAGE = "language"
    FRAMEWORK = "framework"
    LIBRARY = "library"

    # Desktop entities
    APP_NAME = "app_name"
    WINDOW_TITLE = "window_title"
    KEY_COMBINATION = "key_combination"
    MOUSE_POSITION = "mouse_position"
    SCREEN_REGION = "screen_region"

    # File entities
    DIRECTORY = "directory"
    FILE_PATTERN = "file_pattern"
    FILE_EXTENSION = "file_extension"

    # System entities
    PROCESS_NAME = "process_name"
    PORT_NUMBER = "port_number"
    SERVICE_NAME = "service_name"

    # General entities
    QUERY = "query"
    URL = "url"
    TIME_DURATION = "time_duration"
    NUMBER = "number"
    PERSON = "person"
    ORGANIZATION = "organization"


@dataclass
class Entity:
    """Extracted entity."""
    type: EntityType
    value: str
    confidence: float
    start: int
    end: int
    metadata: dict = field(default_factory=dict)


@dataclass
class IntentResult:
    """Result of intent classification."""
    category: IntentCategory
    confidence: float
    entities: list[Entity]
    raw_text: str
    parsed_command: dict | None = None
    suggested_action: str | None = None


class IntentClassifier(ABC):
    """Abstract base class for intent classifiers."""

    @abstractmethod
    async def classify(self, text: str, context: dict | None = None) -> IntentResult:
        """Classify intent from text."""
        pass

    @abstractmethod
    async def train(self, examples: list[tuple[str, IntentCategory]]) -> None:
        """Train classifier with examples."""
        pass


class LLMIntentClassifier(IntentClassifier):
    """LLM-based intent classifier using structured output."""

    def __init__(self, llm_orchestrator: LLMOrchestrator):
        self.llm = llm_orchestrator
        self._system_prompt = self._build_system_prompt()

    def _build_system_prompt(self) -> str:
        """Build classification system prompt."""
        categories = "\n".join([
            f"- {cat.value}: {cat.name.replace('_', ' ').title()}"
            for cat in IntentCategory
        ])

        entity_types = "\n".join([
            f"- {et.value}: {et.name.replace('_', ' ').title()}"
            for et in EntityType
        ])

        return f"""You are an intent classifier for J.A.A., a multi-modal AI assistant.
Classify the user's intent and extract relevant entities.

INTENT CATEGORIES:
{categories}

ENTITY TYPES:
{entity_types}

Return ONLY a JSON object (no markdown, no extra text) with:
- category: the intent category
- confidence: 0.0 to 1.0
- entities: list of {{"type", "value", "confidence", "start", "end"}}
- parsed_command: structured command parameters (optional)
- suggested_action: human-readable description of what to do

Be precise. If unsure, use "unknown" with low confidence."""

    @staticmethod
    def _extract_json(content: str) -> dict:
        """Extract a JSON object from LLM output, tolerating code fences."""
        content = content.strip()
        # Strip markdown code fences if present
        fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
        if fence_match:
            content = fence_match.group(1)
        else:
            # Grab first {...} block
            brace_match = re.search(r"\{.*\}", content, re.DOTALL)
            if brace_match:
                content = brace_match.group(0)
        return json.loads(content)

    async def classify(self, text: str, context: dict | None = None) -> IntentResult:
        """Classify intent using LLM."""
        context_str = json.dumps(context) if context else "none"
        request = LLMRequest(
            messages=[
                SystemMessage(content=self._system_prompt),
                HumanMessage(content=f"User input: {text}\nContext: {context_str}"),
            ],
            model_type=ModelType.GENERAL,
            temperature=0.1,
        )

        try:
            response = await self.llm.generate(request)
            result = self._extract_json(response.content)

            entities = []
            for e in result.get("entities", []):
                try:
                    entities.append(Entity(
                        type=EntityType(e["type"]),
                        value=e["value"],
                        confidence=e.get("confidence", 0.8),
                        start=e.get("start", 0),
                        end=e.get("end", len(text)),
                        metadata=e.get("metadata", {}),
                    ))
                except (ValueError, KeyError):
                    continue  # Skip entities with invalid types

            try:
                category = IntentCategory(result["category"])
            except (ValueError, KeyError):
                category = IntentCategory.UNKNOWN

            return IntentResult(
                category=category,
                confidence=float(result.get("confidence", 0.5)),
                entities=entities,
                raw_text=text,
                parsed_command=result.get("parsed_command"),
                suggested_action=result.get("suggested_action"),
            )
        except Exception as e:
            logger.warning(f"Failed to classify intent via LLM: {e}")
            return IntentResult(
                category=IntentCategory.UNKNOWN,
                confidence=0.1,
                entities=[],
                raw_text=text,
            )

    async def train(self, examples: list[tuple[str, IntentCategory]]) -> None:
        """LLM classifier doesn't need training."""
        pass


class RuleBasedIntentClassifier(IntentClassifier):
    """Fast rule-based intent classifier for common patterns."""

    def __init__(self):
        self._patterns = self._build_patterns()

    def _build_patterns(self) -> list[tuple[re.Pattern, IntentCategory, dict]]:
        """Build regex patterns for intent detection."""
        patterns = [
            # Code patterns
            (re.compile(r"\b(write|create|generate|make|build|implement)\s+(?:a|an|the)?\s*(?:\w+\s+)*(?:code|function|class|script|program|module|api|algorithm|app|application|quicksort|sort|search|tree|graph|database|server|client|library|package)\b", re.I), IntentCategory.CODE_GENERATE, {}),
            (re.compile(r"\b(refactor|improve|optimize|clean up|rewrite)\b", re.I), IntentCategory.CODE_REFACTOR, {}),
            (re.compile(r"\b(debug|fix|error|bug|issue|problem|crash|exception)\b", re.I), IntentCategory.CODE_DEBUG, {}),
            (re.compile(r"\b(explain|what does|how does|describe)\b.*\b(code|function|class|script|program|module|algorithm)\b", re.I), IntentCategory.CODE_EXPLAIN, {}),
            (re.compile(r"\b(test|unit test|integration test|pytest|unittest)\b", re.I), IntentCategory.CODE_TEST, {}),
            (re.compile(r"\b(review|audit|check|analyze)\b.*\b(code|security|performance)\b", re.I), IntentCategory.CODE_REVIEW, {}),
            (re.compile(r"\b(document|docstring|readme|comment)\b", re.I), IntentCategory.CODE_DOCUMENT, {}),
            (re.compile(r"\b(find|search|grep|locate)\b.*\b(code|function|class|variable)\b", re.I), IntentCategory.CODE_SEARCH, {}),

            # Desktop patterns
            (re.compile(r"\b(open|launch|start|run)\b\s+(\w+)", re.I), IntentCategory.DESKTOP_OPEN, {"app_name": 2}),
            (re.compile(r"\b(close|quit|exit|kill)\b\s+(\w+)", re.I), IntentCategory.DESKTOP_CLOSE, {"app_name": 2}),
            (re.compile(r"\b(switch|focus|go to)\b\s+(\w+)", re.I), IntentCategory.DESKTOP_SWITCH, {"app_name": 2}),
            (re.compile(r"\b(arrange|tile|snap|organize)\b.*\b(window|windows)\b", re.I), IntentCategory.DESKTOP_ARRANGE, {}),
            (re.compile(r"\b(screenshot|capture|screen shot)\b", re.I), IntentCategory.DESKTOP_SCREENSHOT, {}),
            (re.compile(r"\b(type|write|enter)\b\s+(.+)", re.I), IntentCategory.DESKTOP_TYPE, {"text": 2}),
            (re.compile(r"\b(click|press)\b\s+(.+)", re.I), IntentCategory.DESKTOP_CLICK, {"target": 2}),
            (re.compile(r"\b(shortcut|hotkey|keybind)\b\s+(.+)", re.I), IntentCategory.DESKTOP_SHORTCUT, {"keys": 2}),

            # File patterns
            (re.compile(r"\b(create|make|new)\b\s+(?:file|folder|directory)\s+(.+)", re.I), IntentCategory.FILE_CREATE, {"path": 2}),
            (re.compile(r"\b(read|open|view|show|cat)\b\s+(?:file\s+)?([^\s]+)", re.I), IntentCategory.FILE_READ, {"path": 2}),
            (re.compile(r"\b(write|save|edit|modify)\b\s+(?:file\s+)?([^\s]+)", re.I), IntentCategory.FILE_WRITE, {"path": 2}),
            (re.compile(r"\b(delete|remove|rm)\b\s+(?:file\s+)?([^\s]+)", re.I), IntentCategory.FILE_DELETE, {"path": 2}),
            (re.compile(r"\b(move|mv)\b\s+(.+)\s+(?:to|into)\s+(.+)", re.I), IntentCategory.FILE_MOVE, {"src": 2, "dst": 3}),
            (re.compile(r"\b(copy|cp)\b\s+(.+)\s+(?:to|into)\s+(.+)", re.I), IntentCategory.FILE_COPY, {"src": 2, "dst": 3}),
            (re.compile(r"\b(find|search|grep|locate)\b\s+(?:file|files?|\.\.?[\\/]|\.\w{1,5}\b)\s*(.+)", re.I), IntentCategory.FILE_SEARCH, {"pattern": 2}),
            (re.compile(r"\b(organize|sort|clean)\b.*\b(download|downloads|desktop|folder)\b", re.I), IntentCategory.FILE_ORGANIZE, {}),

            # System patterns
            (re.compile(r"\b(system|computer|pc|machine)\b.*\b(info|status|specs|specification)\b", re.I), IntentCategory.SYSTEM_INFO, {}),
            (re.compile(r"\b(process|processes|task|tasks)\b", re.I), IntentCategory.SYSTEM_PROCESS, {}),
            (re.compile(r"\b(network|internet|connection|wifi|ethernet)\b", re.I), IntentCategory.SYSTEM_NETWORK, {}),
            (re.compile(r"\b(setting|config|preference|option)\b", re.I), IntentCategory.SYSTEM_SETTINGS, {}),

            # Query patterns
            (re.compile(r"\b(what|who|when|where|why|how)\b", re.I), IntentCategory.QUERY_GENERAL, {}),
            (re.compile(r"\b(search|google|look up|find)\b\s+(.+)", re.I), IntentCategory.QUERY_WEB, {"query": 2}),
            (re.compile(r"\b(remember|recall|memory|history)\b", re.I), IntentCategory.QUERY_MEMORY, {}),

            # Control patterns
            (re.compile(r"\b(stop|halt|abort|cancel)\b", re.I), IntentCategory.CONTROL_STOP, {}),
            (re.compile(r"\b(pause|wait|hold)\b", re.I), IntentCategory.CONTROL_PAUSE, {}),
            (re.compile(r"\b(resume|continue|proceed)\b", re.I), IntentCategory.CONTROL_RESUME, {}),
            (re.compile(r"\b(repeat|again|redo)\b", re.I), IntentCategory.CONTROL_REPEAT, {}),
        ]
        return patterns

    async def classify(self, text: str, context: dict | None = None) -> IntentResult:
        """Classify using regex patterns."""
        # Map capture-group roles to valid EntityTypes
        role_to_entity_type = {
            "app_name": EntityType.APP_NAME,
            "text": EntityType.QUERY,
            "target": EntityType.QUERY,
            "keys": EntityType.KEY_COMBINATION,
            "path": EntityType.FILE_PATH,
            "src": EntityType.FILE_PATH,
            "dst": EntityType.FILE_PATH,
            "pattern": EntityType.FILE_PATTERN,
            "query": EntityType.QUERY,
        }

        best_match: IntentCategory | None = None
        best_confidence = 0.0
        best_entities: list[Entity] = []

        for pattern, category, entity_mapping in self._patterns:
            match = pattern.search(text)
            if not match:
                continue

            confidence = 0.85  # Base confidence for rule match

            # Extract entities from capture groups
            entities = []
            for role, group_num in entity_mapping.items():
                if group_num <= len(match.groups()):
                    value = (match.group(group_num) or "").strip()
                    if value:
                        entities.append(Entity(
                            type=role_to_entity_type.get(role, EntityType.QUERY),
                            value=value,
                            confidence=0.9,
                            start=match.start(group_num),
                            end=match.end(group_num),
                            metadata={"role": role},
                        ))

            if confidence > best_confidence:
                best_confidence = confidence
                best_match = category
                best_entities = entities

        if best_match:
            return IntentResult(
                category=best_match,
                confidence=best_confidence,
                entities=best_entities,
                raw_text=text,
                suggested_action=f"Execute {best_match.value}",
            )

        return IntentResult(
            category=IntentCategory.UNKNOWN,
            confidence=0.1,
            entities=[],
            raw_text=text,
        )

    async def train(self, examples: list[tuple[str, IntentCategory]]) -> None:
        """Rule-based classifier doesn't train."""
        pass


class HybridIntentClassifier(IntentClassifier):
    """Combines rule-based and LLM classifiers."""

    def __init__(self, llm_orchestrator: LLMOrchestrator):
        self.rule_classifier = RuleBasedIntentClassifier()
        self.llm_classifier = LLMIntentClassifier(llm_orchestrator)
        self._confidence_threshold = 0.7

    async def classify(self, text: str, context: dict | None = None) -> IntentResult:
        """Classify using rule-based first, then LLM if uncertain."""
        # Try fast rule-based classification
        rule_result = await self.rule_classifier.classify(text, context)

        if rule_result.confidence >= self._confidence_threshold and rule_result.category != IntentCategory.UNKNOWN:
            return rule_result

        # Fall back to LLM for complex/uncertain cases
        llm_result = await self.llm_classifier.classify(text, context)

        # Return higher confidence result
        if llm_result.confidence > rule_result.confidence:
            return llm_result
        return rule_result

    async def train(self, examples: list[tuple[str, IntentCategory]]) -> None:
        """Train both classifiers."""
        await self.rule_classifier.train(examples)
        await self.llm_classifier.train(examples)


class EntityExtractor:
    """Extracts structured entities from text."""

    def __init__(self):
        self._patterns = self._build_entity_patterns()

    def _build_entity_patterns(self) -> dict[EntityType, list[re.Pattern]]:
        """Build regex patterns for entity extraction."""
        return {
            EntityType.FILE_PATH: [
                re.compile(r"(?:[~/a-zA-Z]:)?(?:[\\/][^\\/:*?\"<>|]+)+[\\/]?", re.I),
                re.compile(r"\b[a-zA-Z]:[\\/][^\\/:*?\"<>|]+(?:[\\/][^\\/:*?\"<>|]+)*", re.I),
            ],
            EntityType.FUNCTION_NAME: [
                re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(", re.I),
            ],
            EntityType.CLASS_NAME: [
                re.compile(r"\bclass\s+([A-Z][a-zA-Z0-9_]*)\b", re.I),
            ],
            EntityType.VARIABLE_NAME: [
                re.compile(r"\b([a-z_][a-z0-9_]*)\s*=", re.I),
            ],
            EntityType.LANGUAGE: [
                re.compile(r"\b(python|javascript|typescript|java|c\+\+|c#|go|rust|ruby|php|swift|kotlin|scala|r|matlab|sql|html|css|json|yaml|toml|xml|markdown|bash|powershell|shell)\b", re.I),
            ],
            EntityType.APP_NAME: [
                re.compile(r"\b(vscode|visual studio code|chrome|firefox|edge|safari|terminal|cmd|powershell|notepad|word|excel|outlook|teams|slack|discord|spotify|vlc|steam|docker|kubernetes|postman|insomnia)\b", re.I),
            ],
            EntityType.URL: [
                re.compile(r"https?://[^\s]+"),
            ],
            EntityType.TIME_DURATION: [
                re.compile(r"\b(\d+)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)\b", re.I),
            ],
            EntityType.NUMBER: [
                re.compile(r"\b\d+(?:\.\d+)?\b"),
            ],
        }

    async def extract(self, text: str, entity_types: list[EntityType] | None = None) -> list[Entity]:
        """Extract entities from text."""
        entities = []
        types_to_extract = entity_types or list(EntityType)

        for entity_type in types_to_extract:
            patterns = self._patterns.get(entity_type, [])
            for pattern in patterns:
                for match in pattern.finditer(text):
                    entities.append(Entity(
                        type=entity_type,
                        value=match.group(0),
                        confidence=0.8,
                        start=match.start(),
                        end=match.end(),
                    ))

        # Deduplicate overlapping entities
        entities = self._deduplicate_entities(entities)
        return entities

    def _deduplicate_entities(self, entities: list[Entity]) -> list[Entity]:
        """Remove overlapping entities, keeping highest confidence."""
        if not entities:
            return []

        # Sort by start position, then by confidence descending
        entities.sort(key=lambda e: (e.start, -e.confidence))

        result = [entities[0]]
        for entity in entities[1:]:
            last = result[-1]
            # Check for overlap
            if entity.start < last.end:
                # Overlapping - keep higher confidence
                if entity.confidence > last.confidence:
                    result[-1] = entity
            else:
                result.append(entity)

        return result


class CommandParser:
    """Parses natural language into structured commands."""

    def __init__(self, llm_orchestrator: LLMOrchestrator):
        self.llm = llm_orchestrator
        self.entity_extractor = EntityExtractor()

    async def parse(self, text: str, intent: IntentResult, context: dict | None = None) -> dict:
        """Parse text into structured command based on intent."""
        # Extract additional entities
        entities = await self.entity_extractor.extract(text)
        all_entities = intent.entities + entities

        # Build command based on intent category
        command = {
            "intent": intent.category.value,
            "raw_text": text,
            "confidence": intent.confidence,
            "entities": [{"type": e.type.value, "value": e.value} for e in all_entities],
            "parameters": intent.parsed_command or {},
        }

        # Add intent-specific parameter extraction
        if intent.category == IntentCategory.CODE_GENERATE:
            command["parameters"].update(await self._parse_code_generate(text, all_entities))
        elif intent.category == IntentCategory.DESKTOP_OPEN:
            command["parameters"].update(await self._parse_desktop_open(text, all_entities))
        elif intent.category == IntentCategory.FILE_SEARCH:
            command["parameters"].update(await self._parse_file_search(text, all_entities))
        elif intent.category == IntentCategory.QUERY_WEB:
            command["parameters"].update(await self._parse_web_query(text, all_entities))

        return command

    async def _parse_code_generate(self, text: str, entities: list[Entity]) -> dict:
        """Parse code generation command."""
        # Extract language
        language = next((e.value for e in entities if e.type == EntityType.LANGUAGE), "python")

        # Extract framework/library mentions
        frameworks = [e.value for e in entities if e.type == EntityType.FRAMEWORK]
        libraries = [e.value for e in entities if e.type == EntityType.LIBRARY]

        return {
            "language": language.lower(),
            "frameworks": frameworks,
            "libraries": libraries,
            "requirements": text,
        }

    async def _parse_desktop_open(self, text: str, entities: list[Entity]) -> dict:
        """Parse desktop open command."""
        app_name = next((e.value for e in entities if e.type == EntityType.APP_NAME), None)

        # Try to extract from text if not found
        if not app_name:
            import re
            match = re.search(r"\b(open|launch|start|run)\s+(\w+)", text, re.I)
            if match:
                app_name = match.group(2)

        return {"app_name": app_name}

    async def _parse_file_search(self, text: str, entities: list[Entity]) -> dict:
        """Parse file search command."""
        pattern = next((e.value for e in entities if e.type == EntityType.FILE_PATTERN), "*")
        directory = next((e.value for e in entities if e.type == EntityType.DIRECTORY), None)

        return {"pattern": pattern, "directory": directory}

    async def _parse_web_query(self, text: str, entities: list[Entity]) -> dict:
        """Parse web search query."""
        query = next((e.value for e in entities if e.type == EntityType.QUERY), text)

        return {"query": query}


class ConversationManager:
    """Manages multi-turn conversation context with token-budget summarization.

    Sessions can be persisted to SQLite (``~/.jaa/memory/sessions.db``) so
    conversations survive restarts - resume with ``jaa chat --resume``.
    """

    def __init__(
        self,
        max_turns: int = 20,
        summarize_tokens: int = 12000,
        summary_tokens: int = 1500,
        session_id: str | None = None,
        project_root: str | None = None,
        db_path: str | None = None,
    ):
        self.max_turns = max_turns
        self.summarize_tokens = summarize_tokens
        self.summary_tokens = summary_tokens
        self.history: list[BaseMessage] = []
        self.summary: str = ""  # condensed summary of the oldest turns
        self.context: dict = {}
        self.active_task: str | None = None
        self.pending_confirmation: dict | None = None
        self.session_id = session_id or self._new_session_id()
        self.project_root = project_root or ""
        self._db_path = Path(db_path) if db_path else Path.home() / ".jaa" / "memory" / "sessions.db"

    def add_user_message(self, content: str) -> None:
        """Add user message to history."""
        self.history.append(HumanMessage(content=content))
        self._trim_history()

    def add_assistant_message(self, content: str) -> None:
        """Add assistant message to history."""
        self.history.append(AIMessage(content=content))
        self._trim_history()

    def _trim_history(self) -> None:
        """Trim history: summarize oldest turns once past the token budget."""
        # Estimate tokens (4 chars ≈ 1 token)
        total = sum(len(m.content) for m in self.history if isinstance(m.content, str)) // 4
        while total > self.summarize_tokens and len(self.history) > 4:
            # Fold the two oldest messages into the rolling summary
            oldest = self.history.pop(0)
            role = "User" if isinstance(oldest, HumanMessage) else "Assistant"
            content = oldest.content if isinstance(oldest.content, str) else ""
            self.summary += f"{role}: {content[:300]}\n"
            total -= len(content) // 4

        # Keep the summary itself bounded
        if len(self.summary) > self.summary_tokens * 4:
            self.summary = self.summary[-(self.summary_tokens * 4):]
            first_newline = self.summary.find("\n")
            if first_newline > 0:
                self.summary = self.summary[first_newline + 1:]

        # Hard cap on turn count as a safety net
        while len(self.history) > self.max_turns * 2:
            self.history.pop(0)

    def get_context_for_llm(self) -> list[BaseMessage]:
        """Get conversation history for LLM (summary + recent turns)."""
        result: list[BaseMessage] = []
        if self.summary:
            result.append(SystemMessage(content=f"Earlier conversation summary:\n{self.summary}"))
        result.extend(self.history.copy())
        return result

    def set_context(self, key: str, value: Any) -> None:
        """Set context variable."""
        self.context[key] = value

    def get_context(self, key: str, default: Any = None) -> Any:
        """Get context variable."""
        return self.context.get(key, default)

    def clear_context(self) -> None:
        """Clear all context."""
        self.context.clear()

    def set_active_task(self, task: str) -> None:
        """Set currently active task."""
        self.active_task = task

    def get_active_task(self) -> str | None:
        """Get active task."""
        return self.active_task

    def set_pending_confirmation(self, action: dict) -> None:
        """Set action pending user confirmation."""
        self.pending_confirmation = action

    def get_pending_confirmation(self) -> dict | None:
        """Get pending confirmation."""
        return self.pending_confirmation

    def clear_pending_confirmation(self) -> None:
        """Clear pending confirmation."""
        self.pending_confirmation = None

    def get_summary(self) -> str:
        """Get conversation summary."""
        if not self.history:
            return "No conversation history."

        recent = self.history[-6:]  # Last 3 exchanges
        summary_parts = []
        for msg in recent:
            role = "User" if isinstance(msg, HumanMessage) else "Assistant"
            content = msg.content[:100] + "..." if len(msg.content) > 100 else msg.content
            summary_parts.append(f"{role}: {content}")

        return "\n".join(summary_parts)

    # -------------------------------------------------------------- persistence
    @staticmethod
    def _new_session_id() -> str:
        import uuid
        return uuid.uuid4().hex[:12]

    def _connect(self):
        import sqlite3

        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._db_path))
        conn.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_root TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                history TEXT NOT NULL DEFAULT '[]'
            )"""
        )
        return conn

    @staticmethod
    def _message_to_dict(message: BaseMessage) -> dict:
        role = "user" if isinstance(message, HumanMessage) else "assistant"
        content = message.content if isinstance(message.content, str) else ""
        return {"role": role, "content": content}

    def save(self) -> None:
        """Persist this session to SQLite (best-effort, never raises)."""
        try:
            conn = self._connect()
            try:
                history_json = json.dumps([self._message_to_dict(m) for m in self.history])
                now = time.time()
                conn.execute(
                    """INSERT INTO sessions (id, project_root, created_at, updated_at, summary, history)
                       VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         project_root=excluded.project_root,
                         updated_at=excluded.updated_at,
                         summary=excluded.summary,
                         history=excluded.history""",
                    (self.session_id, self.project_root, now, now, self.summary, history_json),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as e:
            logger.debug(f"Failed to save session {self.session_id}: {e}")

    def load(self, session_id: str | None = None) -> bool:
        """Load a session by id (defaults to this manager's id). Returns True on success."""
        sid = session_id or self.session_id
        try:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT summary, history FROM sessions WHERE id = ?", (sid,)
                ).fetchone()
            finally:
                conn.close()
            if row is None:
                return False
            summary, history_json = row
            self.session_id = sid
            self.summary = summary or ""
            messages = json.loads(history_json or "[]")
            self.history = []
            for m in messages:
                content = m.get("content", "")
                if m.get("role") == "user":
                    self.history.append(HumanMessage(content=content))
                else:
                    self.history.append(AIMessage(content=content))
            return True
        except Exception as e:
            logger.debug(f"Failed to load session {sid}: {e}")
            return False

    def load_latest(self, project_root: str | None = None) -> str | None:
        """Return the most recently updated session id for a project, if any."""
        root = project_root or self.project_root
        try:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT id FROM sessions WHERE project_root = ? ORDER BY updated_at DESC LIMIT 1",
                    (root,),
                ).fetchone()
            finally:
                conn.close()
            return row[0] if row else None
        except Exception:
            return None

    def list_sessions(self, project_root: str | None = None) -> list[dict]:
        """List saved sessions (optionally filtered by project root)."""
        root = project_root or self.project_root
        try:
            conn = self._connect()
            try:
                if root:
                    rows = conn.execute(
                        "SELECT id, project_root, created_at, updated_at FROM sessions WHERE project_root = ? ORDER BY updated_at DESC",
                        (root,),
                    ).fetchall(

