"""
LLM module for J.A.A.

Provides multi-provider LLM orchestration with local-first approach,
automatic fallback, and model routing.
"""

from __future__ import annotations

try:
    from jaa.llm.orchestrator import (
        LLMOrchestrator,
        LLMProvider,
        LLMRequest,
        LLMResponse,
        LocalOllamaProvider,
        CloudAnthropicProvider,
        CloudOpenAIProvider,
        OpenAICompatibleProvider,
        ModelConfig,
        ModelRouter,
        ModelType,
        ProviderType,
    )
except Exception:  # pragma: no cover - fallback for direct module execution
    from llm.orchestrator import (
        LLMOrchestrator,
        LLMProvider,
        LLMRequest,
        LLMResponse,
        LocalOllamaProvider,
        CloudAnthropicProvider,
        CloudOpenAIProvider,
        OpenAICompatibleProvider,
        ModelConfig,
        ModelRouter,
        ModelType,
        ProviderType,
    )

__all__ = [
    "LLMOrchestrator",
    "LLMProvider",
    "LLMRequest",
    "LLMResponse",
    "LocalOllamaProvider",
    "CloudAnthropicProvider",
    "CloudOpenAIProvider",
    "OpenAICompatibleProvider",
    "ModelConfig",
    "ModelRouter",
    "ModelType",
    "ProviderType",
]