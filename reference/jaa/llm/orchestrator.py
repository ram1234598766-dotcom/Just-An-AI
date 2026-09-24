"""
LLM Orchestrator for J.A.A.

Manages multiple LLM providers (local Ollama + cloud fallbacks),
routes requests to optimal models, and handles streaming responses.
"""

from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncGenerator, Optional

try:
    from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
    from langchain_core.outputs import LLMResult
    from langchain_ollama import ChatOllama, OllamaEmbeddings
except ImportError:  # pragma: no cover - fallback for lightweight environments
    class BaseMessage:
        def __init__(self, content: str = "", **kwargs):
            self.content = content
            self.additional_kwargs = kwargs

    class HumanMessage(BaseMessage):
        pass

    class SystemMessage(BaseMessage):
        pass

    class LLMResult:
        pass

    class ChatOllama:
        def __init__(self, *args, **kwargs):
            self.model = kwargs.get("model", "fallback-model")
            self.temperature = kwargs.get("temperature", 0.3)
            self.num_predict = kwargs.get("num_predict", 256)

        def bind_tools(self, tools):
            self._tools = tools
            return self

        async def ainvoke(self, messages):
            content = "Offline fallback response. Install optional LLM packages to enable full model-backed responses."
            if messages:
                content = f"{content}\nInput: {messages[-1].content if hasattr(messages[-1], 'content') else str(messages[-1])}"
            return type("Resp", (), {"content": content, "usage_metadata": {}, "response_metadata": {"finish_reason": "stop"}})()

        async def astream(self, messages):
            yield await self.ainvoke(messages)

    class OllamaEmbeddings:
        def __init__(self, *args, **kwargs):
            self.model = kwargs.get("model", "fallback-embedding")

        async def aembed_documents(self, texts):
            return [[0.0] * 3 for _ in texts]

try:
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover - fallback for lightweight environments
    class BaseModel:  # type: ignore[override]
        pass

    def Field(*args, **kwargs):
        return None

from jaa.config.settings import LLMSettings, get_settings

logger = logging.getLogger(__name__)


class ModelType(str, Enum):
    """Types of models for different tasks."""
    CODER = "coder"
    GENERAL = "general"
    REASONING = "reasoning"
    EMBEDDING = "embedding"


class ProviderType(str, Enum):
    """LLM provider types."""
    LOCAL = "local"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GOOGLE = "google"
    OPENROUTER = "openrouter"
    COMPATIBLE = "compatible"


@dataclass
class ModelConfig:
    """Configuration for a specific model."""
    name: str
    provider: ProviderType
    model_type: ModelType
    max_tokens: int = 8192
    temperature: float = 0.3
    top_p: float = 0.9
    context_window: int = 32768
    supports_streaming: bool = True
    supports_tools: bool = True
    cost_per_1k_input: float = 0.0
    cost_per_1k_output: float = 0.0


@dataclass
class LLMRequest:
    """Request to LLM."""
    messages: list[BaseMessage]
    model_type: ModelType = ModelType.GENERAL
    temperature: float | None = None
    max_tokens: int | None = None
    stream: bool = True
    tools: list[dict] | None = None
    tool_choice: str | dict | None = None
    metadata: dict = field(default_factory=dict)


@dataclass
class LLMResponse:
    """Response from LLM."""
    content: str
    model: str
    provider: ProviderType
    usage: dict[str, int] = field(default_factory=dict)
    finish_reason: str = "stop"
    tool_calls: list[dict] = field(default_factory=list)
    latency_ms: int = 0


class LLMProvider(ABC):
    """Abstract base class for LLM providers."""

    @abstractmethod
    async def generate(self, request: LLMRequest) -> LLMResponse:
        """Generate completion."""
        pass

    @abstractmethod
    async def generate_stream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        """Generate streaming completion."""
        pass

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings."""
        pass

    @abstractmethod
    def get_model_config(self, model_type: ModelType) -> ModelConfig:
        """Get model configuration."""
        pass

    @abstractmethod
    async def health_check(self) -> bool:
        """Check provider health."""
        pass


class LocalOllamaProvider(LLMProvider):
    """Local Ollama provider."""

    def __init__(self, settings: LLMSettings | None = None):
        self.settings = settings or get_settings().llm
        self._clients: dict[ModelType, ChatOllama] = {}
        self._embedding_client: OllamaEmbeddings | None = None

    def _get_client(self, model_type: ModelType) -> ChatOllama:
        """Get or create Ollama client for model type."""
        if model_type not in self._clients:
            model_name = self.settings.local_models.get(model_type.value)
            if not model_name:
                raise ValueError(f"No model configured for {model_type}")

            self._clients[model_type] = ChatOllama(
                model=model_name,
                base_url=self.settings.effective_base_url,
                temperature=self.settings.temperature,
                top_p=self.settings.top_p,
                num_ctx=self.settings.max_context_tokens,
                keep_alive="5m",
            )
            logger.debug(f"Created Ollama client for {model_type}: {model_name}")

        return self._clients[model_type]

    def _get_embedding_client(self) -> OllamaEmbeddings:
        """Get embedding client."""
        if self._embedding_client is None:
            self._embedding_client = OllamaEmbeddings(
                model=self.settings.local_models.get("embed", "nomic-embed-text:latest"),
                base_url=self.settings.effective_base_url,
            )
        return self._embedding_client

    async def generate(self, request: LLMRequest) -> LLMResponse:
        """Generate completion using Ollama."""
        start_time = time.time()
        client = self._get_client(request.model_type)

        # Configure client for this request
        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.num_predict = request.max_tokens

        # Bind tools if provided (any model type - the tool agent runs on the
        # general model, so gating on CODER broke tool calling on local Ollama)
        if request.tools:
            client = client.bind_tools(request.tools)

        # Generate
        response = await client.ainvoke(request.messages)

        latency_ms = int((time.time() - start_time) * 1000)

        return LLMResponse(
            content=response.content,
            model=client.model,
            provider=ProviderType.LOCAL,
            usage={
                "prompt_tokens": response.usage_metadata.get("input_tokens", 0) if response.usage_metadata else 0,
                "completion_tokens": response.usage_metadata.get("output_tokens", 0) if response.usage_metadata else 0,
            },
            finish_reason=response.response_metadata.get("finish_reason", "stop"),
            tool_calls=getattr(response, "tool_calls", []),
            latency_ms=latency_ms,
        )

    async def generate_stream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        """Generate streaming completion."""
        client = self._get_client(request.model_type)

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.num_predict = request.max_tokens

        if request.tools:
            client = client.bind_tools(request.tools)

        accumulated_content = ""
        tool_calls = []
        start_time = time.time()

        async for chunk in client.astream(request.messages):
            if chunk.content:
                accumulated_content += chunk.content
                yield LLMResponse(
                    content=accumulated_content,
                    model=client.model,
                    provider=ProviderType.LOCAL,
                    finish_reason="streaming",
                    latency_ms=int((time.time() - start_time) * 1000),
                )

            if hasattr(chunk, "tool_calls") and chunk.tool_calls:
                tool_calls.extend(chunk.tool_calls)

        # Final response
        yield LLMResponse(
            content=accumulated_content,
            model=client.model,
            provider=ProviderType.LOCAL,
            usage={},
            finish_reason="stop",
            tool_calls=tool_calls,
            latency_ms=int((time.time() - start_time) * 1000),
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings using Ollama."""
        client = self._get_embedding_client()
        embeddings = await client.aembed_documents(texts)
        return embeddings

    def get_model_config(self, model_type: ModelType) -> ModelConfig:
        """Get model configuration."""
        model_name = self.settings.local_models.get(model_type.value, "unknown")
        return ModelConfig(
            name=model_name,
            provider=ProviderType.LOCAL,
            model_type=model_type,
            max_tokens=8192,
            temperature=self.settings.temperature,
            top_p=self.settings.top_p,
            context_window=self.settings.max_context_tokens,
            supports_streaming=True,
            supports_tools=True,
        )

    async def health_check(self) -> bool:
        """Check if Ollama is reachable."""
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.settings.effective_base_url}/api/tags")
                return response.status_code == 200
        except Exception:
            return False


class CloudAnthropicProvider(LLMProvider):
    """Anthropic Claude provider."""

    def __init__(self, settings: LLMSettings | None = None):
        self.settings = settings or get_settings().llm
        self._client = None

    def _get_client(self):
        """Get or create Anthropic client."""
        if self._client is None:
            from langchain_anthropic import ChatAnthropic
            if not self.settings.anthropic_api_key:
                raise ValueError("Anthropic API key not configured")

            self._client = ChatAnthropic(
                model=self.settings.cloud_models.get("general", "claude-3-5-sonnet-20241022"),
                api_key=self.settings.anthropic_api_key,
                temperature=self.settings.temperature,
                max_tokens=self.settings.max_tokens,
            )
        return self._client

    async def generate(self, request: LLMRequest) -> LLMResponse:
        start_time = time.time()
        client = self._get_client()

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.max_tokens = request.max_tokens

        response = await client.ainvoke(request.messages)
        latency_ms = int((time.time() - start_time) * 1000)

        return LLMResponse(
            content=response.content,
            model=client.model,
            provider=ProviderType.ANTHROPIC,
            usage=response.usage_metadata or {},
            finish_reason=response.response_metadata.get("finish_reason", "stop"),
            latency_ms=latency_ms,
        )

    async def generate_stream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        client = self._get_client()

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.max_tokens = request.max_tokens

        accumulated = ""
        start_time = time.time()

        async for chunk in client.astream(request.messages):
            if chunk.content:
                accumulated += chunk.content
                yield LLMResponse(
                    content=accumulated,
                    model=client.model,
                    provider=ProviderType.ANTHROPIC,
                    finish_reason="streaming",
                    latency_ms=int((time.time() - start_time) * 1000),
                )

        yield LLMResponse(
            content=accumulated,
            model=client.model,
            provider=ProviderType.ANTHROPIC,
            finish_reason="stop",
            latency_ms=int((time.time() - start_time) * 1000),
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError("Anthropic doesn't provide embeddings")

    def get_model_config(self, model_type: ModelType) -> ModelConfig:
        model_name = self.settings.cloud_models.get(model_type.value, "claude-3-5-sonnet-20241022")
        return ModelConfig(
            name=model_name,
            provider=ProviderType.ANTHROPIC,
            model_type=model_type,
            max_tokens=8192,
            temperature=self.settings.temperature,
            top_p=self.settings.top_p,
            context_window=200000,
            supports_streaming=True,
            supports_tools=True,
        )

    async def health_check(self) -> bool:
        try:
            await self._get_client().ainvoke([HumanMessage(content="ping")])
            return True
        except Exception:
            return False


class CloudOpenAIProvider(LLMProvider):
    """OpenAI provider."""

    def __init__(self, settings: LLMSettings | None = None):
        self.settings = settings or get_settings().llm
        self._client = None

    def _get_client(self):
        if self._client is None:
            from langchain_openai import ChatOpenAI
            if not self.settings.openai_api_key:
                raise ValueError("OpenAI API key not configured")

            self._client = ChatOpenAI(
                model=self.settings.cloud_models.get("coder", "gpt-4o"),
                api_key=self.settings.openai_api_key,
                temperature=self.settings.temperature,
                max_tokens=self.settings.max_tokens,
            )
        return self._client

    async def generate(self, request: LLMRequest) -> LLMResponse:
        start_time = time.time()
        client = self._get_client()

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.max_tokens = request.max_tokens

        if request.tools:
            client = client.bind_tools(request.tools)

        response = await client.ainvoke(request.messages)
        latency_ms = int((time.time() - start_time) * 1000)

        return LLMResponse(
            content=response.content,
            model=client.model_name,
            provider=ProviderType.OPENAI,
            usage=response.usage_metadata or {},
            finish_reason=response.response_metadata.get("finish_reason", "stop"),
            tool_calls=getattr(response, "tool_calls", []),
            latency_ms=latency_ms,
        )

    async def generate_stream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        client = self._get_client()

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.max_tokens = request.max_tokens

        if request.tools:
            client = client.bind_tools(request.tools)

        accumulated = ""
        start_time = time.time()

        async for chunk in client.astream(request.messages):
            if chunk.content:
                accumulated += chunk.content
                yield LLMResponse(
                    content=accumulated,
                    model=client.model_name,
                    provider=ProviderType.OPENAI,
                    finish_reason="streaming",
                    latency_ms=int((time.time() - start_time) * 1000),
                )

        yield LLMResponse(
            content=accumulated,
            model=client.model_name,
            provider=ProviderType.OPENAI,
            finish_reason="stop",
            latency_ms=int((time.time() - start_time) * 1000),
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        from langchain_openai import OpenAIEmbeddings
        client = OpenAIEmbeddings(api_key=self.settings.openai_api_key)
        return await client.aembed_documents(texts)

    def get_model_config(self, model_type: ModelType) -> ModelConfig:
        model_name = self.settings.cloud_models.get(model_type.value, "gpt-4o")
        return ModelConfig(
            name=model_name,
            provider=ProviderType.OPENAI,
            model_type=model_type,
            max_tokens=8192,
            temperature=self.settings.temperature,
            top_p=self.settings.top_p,
            context_window=128000,
            supports_streaming=True,
            supports_tools=True,
        )

    async def health_check(self) -> bool:
        try:
            await self._get_client().ainvoke([HumanMessage(content="ping")])
            return True
        except Exception:
            return False


class CloudGoogleProvider(LLMProvider):
    """Google Gemini provider (uses your own GOOGLE_API_KEY)."""

    def __init__(self, settings: LLMSettings | None = None):
        self.settings = settings or get_settings().llm
        self._client = None

    def _get_client(self):
        if self._client is None:
            from langchain_google_genai import ChatGoogleGenerativeAI
            if not self.settings.google_api_key:
                raise ValueError("Google API key not configured")

            model = (
                self.settings.google_models.get("general")
                or self.settings.cloud_models.get("general")
                or "gemini-2.5-flash"
            )
            self._client = ChatGoogleGenerativeAI(
                model=model,
                google_api_key=self.settings.google_api_key,
                temperature=self.settings.temperature,
                max_output_tokens=self.settings.max_tokens,
            )
        return self._client

    def _model_for(self, model_type: ModelType) -> str:
        return (
            self.settings.google_models.get(model_type.value)
            or self.settings.cloud_models.get(model_type.value)
            or "gemini-2.5-flash"
        )

    async def generate(self, request: LLMRequest) -> LLMResponse:
        start_time = time.time()
        client = self._get_client()
        client.model = self._model_for(request.model_type)

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.max_output_tokens = request.max_tokens
        if request.tools:
            client = client.bind_tools(request.tools)

        response = await client.ainvoke(request.messages)
        latency_ms = int((time.time() - start_time) * 1000)

        return LLMResponse(
            content=response.content,
            model=client.model,
            provider=ProviderType.GOOGLE,
            usage=response.usage_metadata or {},
            finish_reason=response.response_metadata.get("finish_reason", "stop"),
            tool_calls=getattr(response, "tool_calls", []),
            latency_ms=latency_ms,
        )

    async def generate_stream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        client = self._get_client()
        client.model = self._model_for(request.model_type)

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.max_output_tokens = request.max_tokens
        if request.tools:
            client = client.bind_tools(request.tools)

        accumulated = ""
        start_time = time.time()

        async for chunk in client.astream(request.messages):
            if chunk.content:
                accumulated += chunk.content
                yield LLMResponse(
                    content=accumulated,
                    model=client.model,
                    provider=ProviderType.GOOGLE,
                    finish_reason="streaming",
                    latency_ms=int((time.time() - start_time) * 1000),
                )

        yield LLMResponse(
            content=accumulated,
            model=client.model,
            provider=ProviderType.GOOGLE,
            finish_reason="stop",
            latency_ms=int((time.time() - start_time) * 1000),
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError("Google embeddings not wired up; use a local embedding model")

    def get_model_config(self, model_type: ModelType) -> ModelConfig:
        return ModelConfig(
            name=self._model_for(model_type),
            provider=ProviderType.GOOGLE,
            model_type=model_type,
            max_tokens=self.settings.max_tokens,
            temperature=self.settings.temperature,
            top_p=self.settings.top_p,
            context_window=1000000,
            supports_streaming=True,
            supports_tools=True,
        )

    async def health_check(self) -> bool:
        try:
            await self._get_client().ainvoke([HumanMessage(content="ping")])
            return True
        except Exception:
            return False


class OpenAICompatibleProvider(LLMProvider):
    """Provider for any OpenAI-compatible API (OpenRouter, Together, Groq, LM Studio, vLLM, ...)."""

    def __init__(
        self,
        settings: LLMSettings | None = None,
        provider_type: ProviderType = ProviderType.COMPATIBLE,
        base_url: str | None = None,
        api_key: str | None = None,
        models: dict[str, str] | None = None,
    ):
        self.settings = settings or get_settings().llm
        self.provider_type = provider_type
        self.base_url = base_url
        self.api_key = api_key
        self.models = models or {}
        self._client = None

    def _get_client(self):
        if self._client is None:
            from langchain_openai import ChatOpenAI
            if not self.api_key:
                raise ValueError(f"API key not configured for {self.provider_type.value}")
            if not self.base_url:
                raise ValueError(f"Base URL not configured for {self.provider_type.value}")

            kwargs = {
                "model": self.models.get("coder") or self.models.get("general") or "gpt-4o",
                "api_key": self.api_key,
                "base_url": self.base_url,
                "temperature": self.settings.temperature,
                "max_tokens": self.settings.max_tokens,
            }
            # OpenRouter likes referrer/title headers for ranking; harmless elsewhere.
            if self.provider_type == ProviderType.OPENROUTER:
                kwargs["default_headers"] = {
                    "HTTP-Referer": "https://github.com/jaa/jaa",
                    "X-Title": "J.A.A. - Just An AI Assistant",
                }
            self._client = ChatOpenAI(**kwargs)
        return self._client

    def _model_for(self, model_type: ModelType) -> str:
        return self.models.get(model_type.value) or self.models.get("general") or "gpt-4o"

    async def generate(self, request: LLMRequest) -> LLMResponse:
        start_time = time.time()
        client = self._get_client()
        client.model = self._model_for(request.model_type)

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.max_tokens = request.max_tokens

        if request.tools:
            client = client.bind_tools(request.tools)

        response = await client.ainvoke(request.messages)
        latency_ms = int((time.time() - start_time) * 1000)

        return LLMResponse(
            content=response.content,
            model=client.model_name,
            provider=self.provider_type,
            usage=response.usage_metadata or {},
            finish_reason=response.response_metadata.get("finish_reason", "stop"),
            tool_calls=getattr(response, "tool_calls", []),
            latency_ms=latency_ms,
        )

    async def generate_stream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        client = self._get_client()
        client.model = self._model_for(request.model_type)

        if request.temperature is not None:
            client.temperature = request.temperature
        if request.max_tokens is not None:
            client.max_tokens = request.max_tokens

        if request.tools:
            client = client.bind_tools(request.tools)

        accumulated = ""
        start_time = time.time()

        async for chunk in client.astream(request.messages):
            if chunk.content:
                accumulated += chunk.content
                yield LLMResponse(
                    content=accumulated,
                    model=client.model_name,
                    provider=self.provider_type,
                    finish_reason="streaming",
                    latency_ms=int((time.time() - start_time) * 1000),
                )

        yield LLMResponse(
            content=accumulated,
            model=client.model_name,
            provider=self.provider_type,
            finish_reason="stop",
            latency_ms=int((time.time() - start_time) * 1000),
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError(f"{self.provider_type.value} doesn't provide embeddings; use a local embedding model")

    def get_model_config(self, model_type: ModelType) -> ModelConfig:
        return ModelConfig(
            name=self._model_for(model_type),
            provider=self.provider_type,
            model_type=model_type,
            max_tokens=8192,
            temperature=self.settings.temperature,
            top_p=self.settings.top_p,
            context_window=128000,
            supports_streaming=True,
            supports_tools=True,
        )

    async def health_check(self) -> bool:
        try:
            await self._get_client().ainvoke([HumanMessage(content="ping")])
            return True
        except Exception:
            return False


class ModelRouter:
    """Routes requests to optimal model based on task type."""

    def __init__(self, settings: LLMSettings | None = None):
        self.settings = settings or get_settings().llm
        # Provider fallback order per task type. LOCAL is always tried first when
        # prefer_local is on; cloud providers fill in as configured.
        self._provider_priority: dict[ModelType, list[ProviderType]] = {
            ModelType.CODER: [
                ProviderType.LOCAL,
                ProviderType.OPENROUTER,
                ProviderType.GOOGLE,
                ProviderType.OPENAI,
                ProviderType.ANTHROPIC,
                ProviderType.COMPATIBLE,
            ],
            ModelType.GENERAL: [
                ProviderType.LOCAL,
                ProviderType.OPENROUTER,
                ProviderType.ANTHROPIC,
                ProviderType.GOOGLE,
                ProviderType.OPENAI,
                ProviderType.COMPATIBLE,
            ],
            ModelType.REASONING: [
                ProviderType.LOCAL,
                ProviderType.OPENROUTER,
                ProviderType.GOOGLE,
                ProviderType.OPENAI,
                ProviderType.ANTHROPIC,
                ProviderType.COMPATIBLE,
            ],
            ModelType.EMBEDDING: [ProviderType.LOCAL, ProviderType.OPENAI],
        }

    def get_provider_order(self, model_type: ModelType) -> list[ProviderType]:
        """Get provider priority order for model type."""
        if self.settings.prefer_local:
            return self._provider_priority.get(model_type, [ProviderType.LOCAL])
        else:
            # Cloud first
            order = self._provider_priority.get(model_type, [ProviderType.LOCAL])
            # Move cloud providers to front
            cloud_providers = [p for p in order if p != ProviderType.LOCAL]
            local_providers = [p for p in order if p == ProviderType.LOCAL]
            return cloud_providers + local_providers


class LLMOrchestrator:
    """Main LLM orchestration layer."""

    def __init__(self, settings: LLMSettings | None = None):
        self.settings = settings or get_settings().llm
        self.router = ModelRouter(self.settings)

        # Initialize providers
        self.providers: dict[ProviderType, LLMProvider] = {
            ProviderType.LOCAL: LocalOllamaProvider(self.settings),
        }

        if self.settings.cloud_enabled:
            if self.settings.anthropic_api_key:
                self.providers[ProviderType.ANTHROPIC] = CloudAnthropicProvider(self.settings)
            if self.settings.openai_api_key:
                self.providers[ProviderType.OPENAI] = CloudOpenAIProvider(self.settings)
            if self.settings.google_api_key:
                self.providers[ProviderType.GOOGLE] = CloudGoogleProvider(self.settings)
            if self.settings.openrouter_api_key:
                self.providers[ProviderType.OPENROUTER] = OpenAICompatibleProvider(
                    self.settings,
                    provider_type=ProviderType.OPENROUTER,
                    base_url="https://openrouter.ai/api/v1",
                    api_key=self.settings.openrouter_api_key,
                    models=self.settings.openrouter_models,
                )
            if self.settings.compatible_base_url and self.settings.compatible_api_key:
                self.providers[ProviderType.COMPATIBLE] = OpenAICompatibleProvider(
                    self.settings,
                    provider_type=ProviderType.COMPATIBLE,
                    base_url=self.settings.compatible_base_url,
                    api_key=self.settings.compatible_api_key,
                    models=self.settings.compatible_models,
                )

        self._health_cache: dict[ProviderType, tuple[bool, float]] = {}
        self._health_ttl = 60  # seconds

    async def initialize(self) -> None:
        """Initialize all providers."""
        logger.info("Initializing LLM providers...")
        for provider_type, provider in self.providers.items():
            try:
                healthy = await provider.health_check()
                self._health_cache[provider_type] = (healthy, time.time())
                status = "healthy" if healthy else "unhealthy"
                logger.info(f"Provider {provider_type}: {status}")
            except Exception as e:
                logger.warning(f"Provider {provider_type} health check failed: {e}")
                self._health_cache[provider_type] = (False, time.time())

    def _is_healthy(self, provider_type: ProviderType) -> bool:
        """Check if provider is healthy (with caching)."""
        if provider_type not in self._health_cache:
            return False

        healthy, timestamp = self._health_cache[provider_type]
        if time.time() - timestamp > self._health_ttl:
            # Expired, will recheck on next use
            return healthy
        return healthy

    async def _get_healthy_provider(self, model_type: ModelType) -> LLMProvider:
        """Get first healthy provider for model type."""
        provider_order = self.router.get_provider_order(model_type)

        for provider_type in provider_order:
            if provider_type in self.providers and self._is_healthy(provider_type):
                return self.providers[provider_type]

        # Fallback: try any available provider
        for provider_type in provider_order:
            if provider_type in self.providers:
                logger.warning(f"Using potentially unhealthy provider: {provider_type}")
                return self.providers[provider_type]

        raise RuntimeError(
            f"No LLM provider available for '{model_type.value}'. "
            "Is Ollama running? Start it with `ollama serve` (or `jaa setup`), "
            "or add a cloud key with `jaa key set openrouter <key>`."
        )

    async def generate(self, request: LLMRequest) -> LLMResponse:
        """Generate completion with automatic fallback."""
        provider = await self._get_healthy_provider(request.model_type)

        try:
            response = await provider.generate(request)
            logger.debug(f"Generated response using {response.provider} ({response.model})")
            return response
        except Exception as e:
            logger.warning(f"Provider {provider.__class__.__name__} failed: {e}")
            # Mark as unhealthy
            failed_type = None
            for ptype, prov in self.providers.items():
                if prov is provider:
                    failed_type = ptype
                    self._health_cache[ptype] = (False, time.time())
                    break

            # Try remaining providers in priority order
            provider_order = self.router.get_provider_order(request.model_type)
            for ptype in provider_order:
                if ptype != failed_type and ptype in self.providers:
                    try:
                        response = await self.providers[ptype].generate(request)
                        self._health_cache[ptype] = (True, time.time())
                        return response
                    except Exception as e2:
                        logger.warning(f"Fallback provider {ptype} also failed: {e2}")
                        self._health_cache[ptype] = (False, time.time())

            raise RuntimeError(
                f"All providers failed for '{request.model_type.value}'. "
                "Check that Ollama is running and your cloud keys are valid (`jaa key list`)."
            ) from e

    async def generate_stream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        """Generate streaming completion with automatic fallback."""
        provider = await self._get_healthy_provider(request.model_type)

        try:
            async for response in provider.generate_stream(request):
                yield response
        except Exception as e:
            logger.warning(f"Streaming provider failed: {e}")
            # For streaming, we can't easily fallback mid-stream
            # Just raise
            raise

    async def embed(self, texts: list[str], model_type: ModelType = ModelType.EMBEDDING) -> list[list[float]]:
        """Generate embeddings."""
        provider = await self._get_healthy_provider(model_type)
        return await provider.embed(texts)

    async def shutdown(self) -> None:
        """Shutdown all providers and release resources."""
        logger.info("Shutting down LLM orchestrator")
        self._health_cache.clear()

    def get_available_models(self) -> dict[str, list[str]]:
        """Get available models by provider."""
        result = {}
        for ptype, provider in self.providers.items():
            models = []
            for mtype in ModelType:
                try:
                    config = provider.get_model_config(mtype)
                    models.append(f"{mtype.value}:{config.name}")
                except Exception:
                    pass
            if models:
                result[ptype.value] = models
        return result