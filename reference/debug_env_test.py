import os
import warnings

warnings.filterwarnings("ignore")

from pydantic_settings import BaseSettings, SettingsConfigDict


class LLMSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="JAA_LLM_")
    openrouter_api_key: str | None = None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="JAA_",
        env_nested_delimiter="__",
        extra="ignore",
    )
    llm: LLMSettings = LLMSettings()


print("env var present:", os.environ.get("JAA_LLM_OPENROUTER_API_KEY"))
s = Settings()
print("nested key from real env var:", repr(s.llm.openrouter_api_key))
