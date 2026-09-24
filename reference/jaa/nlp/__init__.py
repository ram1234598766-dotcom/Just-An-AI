"""
NLP module for J.A.A.

Provides intent classification, entity extraction, command parsing,
and conversation management.
"""

from __future__ import annotations

try:
    from jaa.nlp.intent import (
        CommandParser,
        ConversationManager,
        Entity,
        EntityExtractor,
        EntityType,
        HybridIntentClassifier,
        IntentCategory,
        IntentResult,
        IntentClassifier,
        LLMIntentClassifier,
        RuleBasedIntentClassifier,
    )
except Exception:  # pragma: no cover - fallback for direct module execution
    from nlp.intent import (
        CommandParser,
        ConversationManager,
        Entity,
        EntityExtractor,
        EntityType,
        HybridIntentClassifier,
        IntentCategory,
        IntentResult,
        IntentClassifier,
        LLMIntentClassifier,
        RuleBasedIntentClassifier,
    )

__all__ = [
    "CommandParser",
    "ConversationManager",
    "Entity",
    "EntityExtractor",
    "EntityType",
    "HybridIntentClassifier",
    "IntentCategory",
    "IntentResult",
    "IntentClassifier",
    "LLMIntentClassifier",
    "RuleBasedIntentClassifier",
]