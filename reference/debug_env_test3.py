import os
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from pydantic_settings import BaseSettings, SettingsConfigDict

tmp = Path(tempfile.mkdtemp())
(tmp / ".jaa").mkdir()
(tmp / ".jaa" / ".env").write_text(
    "JAA_TEST_KEY=sk-flat-111\n"
    "JAA_LLM_OPENROUTER_API_KEY=sk-nested-222\n"
    "JAA__LLM__OPENROUTER_API_KEY=sk-double-333\n"
)
os.environ["USERPROFILE"] = str(tmp)
os.environ["HOME"] = str(tmp)


class LLMSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="JAA_LLM_")
    openrouter_api_key: str | None = None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="JAA_",
        env_file=(str(Path.home() / ".jaa" / ".env"),),
        env_file_encoding="utf-8",
        env_nested_delimiter="__",
        extra="ignore",
    )
    test_key: str | None = None
    llm: LLMSettings = LLMSettings()


s = Settings()
print("flat test_key:", repr(s.test_key))
print("nested (JAA_LLM_ prefix):", repr(s.llm.openrouter_api_key))
