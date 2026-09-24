"""
J.A.A. (Just An AI Assistant) - Core Configuration
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

try:
    from pydantic import Field, field_validator
    from pydantic_settings import BaseSettings, SettingsConfigDict
except ImportError:  # pragma: no cover - fallback for lightweight environments
    class FieldInfo:
        def __init__(self, default=None, default_factory=None):
            self.default = default
            self.default_factory = default_factory

    def Field(default=None, default_factory=None):
        return FieldInfo(default=default, default_factory=default_factory)

    def field_validator(*args, **kwargs):
        def decorator(func):
            return func
        return decorator

    class SettingsConfigDict(dict):
        pass

    class BaseSettings:
        model_config = {}

        def __init__(self, **data):
            self._apply_defaults(data)
            self.model_post_init({})

        def _apply_defaults(self, data):
            annotations = getattr(self.__class__, "__annotations__", {})
            for name in annotations:
                if name.startswith("_"):
                    continue
                if name in data:
                    value = data[name]
                else:
                    default_value = getattr(self.__class__, name, None)
                    if isinstance(default_value, FieldInfo):
                        value = default_value.default_factory() if default_value.default_factory else default_value.default
                    else:
                        value = default_value

                if value is None and annotations[name] is bool:
                    value = False
                elif value is None and annotations[name] is int:
                    value = 0
                elif value is None and annotations[name] is float:
                    value = 0.0
                elif value is None and annotations[name] is str:
                    value = ""
                elif value is None and annotations[name] is list:
                    value = []
                elif value is None and annotations[name] is dict:
                    value = {}

                setattr(self, name, value)

        def model_post_init(self, __context):
            return None


class VoiceSettings(BaseSettings):
    """Voice pipeline configuration."""
    model_config = SettingsConfigDict(env_prefix="JAA_VOICE_")

    # STT Settings
    stt_engine: Literal["faster-whisper", "whisper", "vosk"] = "faster-whisper"
    stt_model: str = "base.en"
    stt_device: Literal["cpu", "cuda", "auto"] = "auto"
    stt_compute_type: Literal["float16", "int8", "float32"] = "float16"
    stt_language: str = "en"
    stt_vad_filter: bool = True
    stt_vad_threshold: float = 0.5

    # Wake Word
    wake_word: str = "hey jaa"
    wake_word_sensitivity: float = 0.7
    wake_word_timeout: float = 5.0

    # TTS Settings
    tts_engine: Literal["piper", "coqui", "bark", "system"] = "piper"
    tts_voice: str = "en_US-lessac-medium"
    tts_speed: float = 1.0
    tts_volume: float = 0.9
    tts_device: Literal["cpu", "cuda"] = "cpu"

    # Audio
    sample_rate: int = 16000
    channels: int = 1
    chunk_size: int = 1024
    silence_threshold: float = 0.01
    silence_duration: float = 1.5


class LLMSettings(BaseSettings):
    """LLM orchestration configuration."""
    model_config = SettingsConfigDict(env_prefix="JAA_LLM_")

    # Local Models (Ollama)
    local_provider: Literal["ollama", "llama.cpp", "vllm"] = "ollama"
    ollama_host: str = "http://localhost:11434"
    base_url: str | None = None
    local_models: dict[str, str] = Field(default_factory=lambda: {
        # Defaults tuned for ~8GB VRAM, verified to exist on the Ollama registry.
        # Override via JAA_LLM_LOCAL_MODELS (e.g. qwen3-coder:30b on bigger GPUs).
        "coder": "qwen2.5-coder:7b",
        "general": "qwen3:8b",
        "reasoning": "qwen3:4b",
        "embed": "nomic-embed-text:latest",
    })

    @property
    def effective_base_url(self) -> str:
        return self.base_url or self.ollama_host

    # Cloud Fallbacks
    cloud_enabled: bool = True
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    google_api_key: str | None = None
    openrouter_api_key: str | None = None

    cloud_models: dict[str, str] = Field(default_factory=lambda: {
        "coder": "gpt-4o",
        "general": "claude-sonnet-4-20250514",
        "reasoning": "o4-mini",
    })

    # Google Gemini models (used when JAA_LLM_GOOGLE_API_KEY is set).
    google_models: dict[str, str] = Field(default_factory=lambda: {
        "coder": "gemini-2.5-pro",
        "general": "gemini-2.5-flash",
        "reasoning": "gemini-2.5-pro",
    })

    # OpenRouter (https://openrouter.ai) - one key, hundreds of models.
    openrouter_models: dict[str, str] = Field(default_factory=lambda: {
        "coder": "openai/gpt-4o",
        "general": "anthropic/claude-3.5-sonnet",
        "reasoning": "deepseek/deepseek-r1",
    })

    # Generic OpenAI-compatible endpoint (LM Studio, vLLM, Together, Groq, DeepSeek, etc.)
    compatible_base_url: str | None = None
    compatible_api_key: str | None = None
    compatible_models: dict[str, str] = Field(default_factory=lambda: {
        "coder": "gpt-4o",
        "general": "gpt-4o-mini",
        "reasoning": "gpt-4o-mini",
    })

    # Routing
    prefer_local: bool = True
    local_confidence_threshold: float = 0.7
    max_tokens: int = 8192
    temperature: float = 0.3
    top_p: float = 0.9

    # Context (budgeting keeps long sessions cheap)
    max_context_tokens: int = 32768
    context_window_reserve: int = 4096
    # Cap on a single tool result / file read fed back to the model (chars).
    max_tool_result_chars: int = 4000
    # Summarize conversation history once it exceeds this many tokens.
    history_summarize_tokens: int = 12000
    history_summary_tokens: int = 1500


class AgentSettings(BaseSettings):
    """Agent behavior configuration."""
    model_config = SettingsConfigDict(env_prefix="JAA_AGENT_")

    # Code Agent
    code_enabled: bool = True
    code_max_iterations: int = 10
    code_auto_test: bool = False
    code_test_command: str = "pytest -xvs"
    code_lint_command: str = "ruff check"
    code_format_command: str = "ruff format"

    # Desktop Agent
    desktop_enabled: bool = True
    desktop_safety_mode: bool = True
    desktop_confirm_destructive: bool = True
    desktop_allowed_paths: list[str] = Field(default_factory=lambda: [
        str(Path.home() / "Documents"),
        str(Path.home() / "Downloads"),
        str(Path.home() / "Desktop"),
        str(Path.home() / "Projects"),
    ])
    desktop_blocked_paths: list[str] = Field(default_factory=lambda: [
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "/System",
        "/usr/bin",
        "/etc",
    ])

    # System Agent
    system_enabled: bool = True
    system_monitor_interval: int = 30


class MemorySettings(BaseSettings):
    """Memory and context configuration."""
    model_config = SettingsConfigDict(env_prefix="JAA_MEMORY_")

    # Vector Store
    vector_store: Literal["chromadb", "faiss", "qdrant"] = "chromadb"
    chromadb_path: str = str(Path.home() / ".jaa" / "chromadb")
    collection_name: str = "jaa_memory"
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_dim: int = 384

    # Memory Types
    short_term_turns: int = 10
    long_term_max_entries: int = 10000
    memory_consolidation_interval: int = 3600

    # Retrieval
    retrieval_top_k: int = 5
    retrieval_score_threshold: float = 0.7
    retrieval_rerank: bool = True


class SecuritySettings(BaseSettings):
    """Security and sandboxing configuration."""
    model_config = SettingsConfigDict(env_prefix="JAA_SECURITY_")

    # Command Execution
    allow_shell: bool = False
    allowed_commands: list[str] = Field(default_factory=lambda: [
        "ls", "dir", "cd", "pwd", "cat", "type", "head", "tail",
        "grep", "find", "rg", "fd", "git", "python", "pip", "npm",
        "cargo", "go", "dotnet", "java", "node", "deno", "bun",
        "pytest", "ruff", "black", "mypy", "tree",
    ])
    blocked_commands: list[str] = Field(default_factory=lambda: [
        "rm", "del", "format", "fdisk", "mkfs", "dd",
        "shutdown", "reboot", "poweroff", "halt",
        "passwd", "sudo", "su", "chmod", "chown",
        "iptables", "ufw", "firewall-cmd",
        "curl", "wget", "powershell", "cmd.exe",
    ])

    # File Operations
    max_file_size: int = 10 * 1024 * 1024  # 10MB
    allowed_extensions: list[str] = Field(default_factory=lambda: [
        ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".yaml", ".yml",
        ".toml", ".ini", ".cfg", ".md", ".txt", ".rst", ".html", ".css",
        ".scss", ".sass", ".less", ".sql", ".sh", ".bat", ".ps1",
        ".rs", ".go", ".java", ".kt", ".swift", ".cpp", ".c", ".h",
        ".cs", ".vb", ".php", ".rb", ".pl", ".lua", ".r", ".m",
        ".dart", ".zig", ".nim", ".jl", ".ex", ".exs", ".erl",
    ])

    # Network
    allow_network: bool = False
    allowed_domains: list[str] = Field(default_factory=list)
    blocked_domains: list[str] = Field(default_factory=lambda: [
        "localhost", "127.0.0.1", "0.0.0.0", "::1",
        "169.254.169.254",  # AWS metadata
    ])


class UISettings(BaseSettings):
    """UI/TUI configuration."""
    model_config = SettingsConfigDict(env_prefix="JAA_UI_")

    theme: Literal["dark", "light", "auto"] = "dark"
    color_scheme: str = "tokyo-night"
    show_timestamps: bool = True
    show_token_usage: bool = True
    compact_mode: bool = False
    animations: bool = True
    notification_sound: bool = True


def load_env_files() -> None:
    """Load the user's own env files into the process environment.

    Priority (lowest to highest): ~/.jaa/.env  <  project .env  <  real env vars.
    pydantic-settings only applies env_file to flat fields, so we load dotenv
    files manually to make sure nested models (like LLMSettings) see them.
    """
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - fallback
        return
    load_dotenv(Path.home() / ".jaa" / ".env", override=False)
    load_dotenv(".env", override=False)


class Settings(BaseSettings):
    """Main J.A.A. settings."""
    model_config = SettingsConfigDict(
        env_prefix="JAA_",
        env_file_encoding="utf-8",
        env_nested_delimiter="__",
        extra="ignore",
    )

    # App
    app_name: str = "J.A.A."
    app_version: str = "0.2.0"
    data_dir: Path = Field(default_factory=lambda: Path.home() / ".jaa")
    skills_dir: Path = Field(default_factory=lambda: Path.home() / ".jaa" / "skills")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    debug: bool = False

    # Sub-configs
    voice: VoiceSettings = Field(default_factory=VoiceSettings)
    llm: LLMSettings = Field(default_factory=LLMSettings)
    agent: AgentSettings = Field(default_factory=AgentSettings)
    memory: MemorySettings = Field(default_factory=MemorySettings)
    security: SecuritySettings = Field(default_factory=SecuritySettings)
    ui: UISettings = Field(default_factory=UISettings)

    @field_validator("data_dir", mode="before")
    @classmethod
    def expand_data_dir(cls, v: str | Path) -> Path:
        return Path(v).expanduser().resolve()

    def model_post_init(self, __context: Any) -> None:
        """Create data directories after initialization."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "logs").mkdir(exist_ok=True)
        (self.data_dir / "cache").mkdir(exist_ok=True)
        (self.data_dir / "memory").mkdir(exist_ok=True)
        (self.data_dir / "voice").mkdir(exist_ok=True)
        (self.data_dir / "skills").mkdir(exist_ok=True)


# Global settings instance
_settings: Settings | None = None


def get_settings() -> Settings:
    """Get global settings instance."""
    global _settings
    if _settings is None:
        load_env_files()
        _settings = Settings()
    return _settings


def reload_settings() -> Settings:
    """Reload settings from environment."""
    global _settings
    load_env_files()
    _settings = Settings()
    return _settings