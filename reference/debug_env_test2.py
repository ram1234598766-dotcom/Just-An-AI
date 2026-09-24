import os
import tempfile
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from pydantic_settings import BaseSettings, SettingsConfigDict

tmp = Path(tempfile.mkdtemp())
(tmp / ".jaa").mkdir()
(tmp / ".jaa" / ".env").write_text("JAA_LLM_OPENROUTER_API_KEY=sk-file-456\n")
os.environ["USERPROFILE"] = str(tmp)
os.environ["HOME"] = str(tmp)


class LLMSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="JAA_LLM_")
    openrouter_api_key: str | None = None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="JAA_",
        env_file=(".env", str(Path.home() / ".jaa" / ".env")),
        env_file_encoding="utf-8",
        env_nested_delimiter="__",
        extra="ignore",
    )
    llm: LLMSettings = LLMSettings()


print("home:", Path.home())
print("file exists:", (Path.home() / ".jaa" / ".env").exists())
s = Settings()
print("nested key from env_file:", repr(s.llm.openrouter_api_key))
