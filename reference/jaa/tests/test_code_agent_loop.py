import asyncio
import tempfile
import unittest
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from jaa.agents.code_agent import CodeAgent, CodeState


class FakeLLM:
    """Simulates a model that writes a file, runs it, then answers."""

    def __init__(self):
        self.calls = 0

    async def generate(self, request):
        from jaa.llm.orchestrator import LLMResponse, ProviderType

        self.calls += 1
        if self.calls == 1:
            return LLMResponse(
                content="",
                model="mock",
                provider=ProviderType.LOCAL,
                tool_calls=[
                    {
                        "id": "call_1",
                        "name": "write_file",
                        "args": {"path": "hello.py", "content": 'print("hi")\n'},
                    }
                ],
            )
        if self.calls == 2:
            return LLMResponse(
                content="",
                model="mock",
                provider=ProviderType.LOCAL,
                tool_calls=[
                    {
                        "id": "call_2",
                        "name": "run_command",
                        "args": {"command": "python hello.py"},
                    }
                ],
            )
        return LLMResponse(
            content="Wrote and ran the script.",
            model="mock",
            provider=ProviderType.LOCAL,
            tool_calls=[],
        )


class CodeAgentLoopTests(unittest.TestCase):
    def test_agentic_loop_feeds_tool_results_back(self) -> None:
        async def scenario():
            llm = FakeLLM()
            with tempfile.TemporaryDirectory() as td:
                agent = CodeAgent(td, llm)
                state = CodeState(task="write hello script")
                state.plan = ["Create and run a script"]
                state.context = None
                state.execution_stats = {}
                result = await agent._execute_step(state)

                self.assertEqual(state.execution_stats["tool_calls"], 2)
                self.assertEqual(len(state.files_modified), 1)
                self.assertEqual((Path(td) / "hello.py").read_text(), 'print("hi")\n')
                self.assertEqual(state.execution_stats["steps_completed"], 1)
                # The run_command tool result must be visible in the step's message trail
                self.assertTrue(
                    any("Exit code" in str(getattr(m, "content", "")) for m in state.messages),
                    "tool result not fed back into state.messages",
                )
                return result

        asyncio.run(scenario())

    def test_execution_stats_initialized_with_start_time(self) -> None:
        """Regression: execute() seeds stats with start_time only; _execute_step must not KeyError."""

        class StaticLLM(FakeLLM):
            async def generate(self, request):
                from jaa.llm.orchestrator import LLMResponse, ProviderType

                return LLMResponse(
                    content="1. Done.",
                    model="mock",
                    provider=ProviderType.LOCAL,
                    tool_calls=[],
                )

        async def scenario():
            with tempfile.TemporaryDirectory() as td:
                agent = CodeAgent(td, StaticLLM())
                out = await agent.execute("write a file", None)
                self.assertIn("Task completed", out)

        asyncio.run(scenario())

    def test_shell_allowlist_blocks_dangerous_commands(self) -> None:
        async def scenario():
            with tempfile.TemporaryDirectory() as td:
                agent = CodeAgent(td, FakeLLM())
                out = agent._run_safe_command("sudo rm -rf /")
                self.assertIn("blocked", out.lower())
                out2 = agent._run_safe_command("python --version")
                self.assertIn("Python", out2)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
