"""
Code Agent for J.A.A.

LangGraph-based workflow for code generation, refactoring, debugging,
testing, and codebase understanding with enhanced error handling and retry mechanisms.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool, tool
from langgraph.graph import END, StateGraph
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel, Field

from jaa.config.settings import get_settings
from jaa.llm import LLMOrchestrator, LLMRequest, ModelType
from jaa.utils import AsyncCache, retry, timeout

logger = logging.getLogger(__name__)


@dataclass
class CodeContext:
    """Context for code operations."""
    project_root: Path
    current_file: Path | None = None
    related_files: list[Path] = field(default_factory=list)
    symbols: dict[str, list[str]] = field(default_factory=dict)
    imports: list[str] = field(default_factory=list)
    language: str = "python"
    framework: str | None = None


class CodeState(BaseModel):
    """State for code agent workflow."""
    model_config = {"arbitrary_types_allowed": True}

    task: str
    context: CodeContext | None = None
    messages: list[Any] = Field(default_factory=list)
    plan: list[str] = Field(default_factory=list)
    current_step: int = 0
    files_modified: list[Path] = Field(default_factory=list)
    tests_run: bool = False
    test_results: str | None = None
    errors: list[str] = Field(default_factory=list)
    final_output: str | None = None
    execution_stats: dict[str, Any] = Field(default_factory=dict)
    retry_counts: dict[str, int] = Field(default_factory=dict)
    last_error: str | None = None
    # Enhanced fields for better error handling


class CodeTool(BaseTool):
    """Base class for code agent tools."""

    def __init__(self, project_root: Path):
        super().__init__()
        self._project_root = project_root

    @property
    def project_root(self) -> Path:
        return self._project_root


class FileOperations:
    """File operation tools for code agent."""

    def __init__(self, project_root: Path):
        self.project_root = project_root.resolve()

    def _resolve(self, path: str) -> Path:
        """Resolve a path and ensure it stays inside the project root."""
        full_path = (self.project_root / path).resolve()
        if not full_path.is_relative_to(self.project_root):
            raise PermissionError(f"Path outside project root: {path}")
        return full_path

    def read_file(self, path: str) -> str:
        """Read file content."""
        full_path = self._resolve(path)
        if not full_path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        return full_path.read_text(encoding="utf-8")

    def write_file(self, path: str, content: str) -> None:
        """Write file content."""
        full_path = self._resolve(path)
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")

    def edit_file(self, path: str, old_text: str, new_text: str) -> bool:
        """Edit file by replacing text."""
        full_path = self._resolve(path)
        if not full_path.exists():
            raise FileNotFoundError(f"File not found: {path}")

        content = full_path.read_text(encoding="utf-8")
        if old_text not in content:
            raise ValueError(f"Text not found in file: {old_text[:50]}...")

        new_content = content.replace(old_text, new_text)
        full_path.write_text(new_content, encoding="utf-8")
        return True

    def list_files(self, pattern: str = "**/*") -> list[str]:
        """List files matching pattern."""
        files = list(self.project_root.glob(pattern))
        return [str(f.relative_to(self.project_root)) for f in files if f.is_file()]

    def glob(self, pattern: str) -> list[str]:
        """Glob files."""
        files = list(self.project_root.glob(pattern))
        return [str(f.relative_to(self.project_root)) for f in files]

    def delete_file(self, path: str) -> bool:
        """Delete file or directory (project-scoped). Returns True on success."""
        full_path = self._resolve(path)
        try:
            if full_path.is_dir():
                import shutil
                shutil.rmtree(full_path)
            else:
                full_path.unlink(missing_ok=True)
            return True
        except Exception as e:
            raise RuntimeError(f"Failed to delete {path}: {e}") from e

    def find_files(self, directory: str, name_pattern: str, content_pattern: str | None = None) -> list[str]:
        """Find files by name (fnmatch) and optionally by content."""
        import fnmatch

        base = self._resolve(directory or ".")
        results = []
        for file_path in base.rglob("*"):
            if not file_path.is_file():
                continue
            if not fnmatch.fnmatch(file_path.name, name_pattern):
                continue
            if content_pattern:
                try:
                    content = file_path.read_text(encoding="utf-8", errors="ignore")
                    if content_pattern.lower() not in content.lower():
                        continue
                except Exception:
                    continue
            results.append(str(file_path.relative_to(self.project_root)))
        return results

    def move_file(self, src: str, dst: str) -> bool:
        """Move a file or directory within the project."""
        src_path = self._resolve(src)
        dst_path = self._resolve(dst)
        try:
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            src_path.rename(dst_path)
            return True
        except Exception as e:
            raise RuntimeError(f"Failed to move {src} to {dst}: {e}") from e

    def copy_file(self, src: str, dst: str) -> bool:
        """Copy a file or directory within the project."""
        import shutil

        src_path = self._resolve(src)
        dst_path = self._resolve(dst)
        try:
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            if src_path.is_dir():
                shutil.copytree(src_path, dst_path, dirs_exist_ok=True)
            else:
                shutil.copy2(src_path, dst_path)
            return True
        except Exception as e:
            raise RuntimeError(f"Failed to copy {src} to {dst}: {e}") from e


class GitOperations:
    """Git operation tools."""

    def __init__(self, project_root: Path):
        self.project_root = project_root

    def _run_git(self, args: list[str]) -> str:
        """Run git command."""
        result = subprocess.run(
            ["git"] + args,
            cwd=self.project_root,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Git command failed: {result.stderr}")
        return result.stdout.strip()

    def status(self) -> str:
        """Get git status."""
        return self._run_git(["status", "--short"])

    def diff(self, staged: bool = False) -> str:
        """Get git diff."""
        args = ["diff"]
        if staged:
            args.append("--cached")
        return self._run_git(args)

    def add(self, paths: list[str] | str = ".") -> None:
        """Stage files."""
        if isinstance(paths, str):
            paths = [paths]
        self._run_git(["add"] + paths)

    def commit(self, message: str) -> str:
        """Commit changes."""
        return self._run_git(["commit", "-m", message])

    def push(self, remote: str = "origin", branch: str | None = None) -> str:
        """Push changes."""
        args = ["push", remote]
        if branch:
            args.append(branch)
        return self._run_git(args)

    def log(self, n: int = 10) -> str:
        """Get recent commits."""
        return self._run_git(["log", "--oneline", f"-{n}"])

    def branch(self) -> str:
        """Get current branch."""
        return self._run_git(["branch", "--show-current"])


class LSPClient:
    """Language Server Protocol client for code intelligence."""

    def __init__(self, project_root: Path):
        self.project_root = project_root
        self._servers: dict[str, Any] = {}

    async def initialize(self, language: str) -> bool:
        """Initialize LSP server for language."""
        # This would connect to actual LSP servers
        # For now, return True to indicate availability
        return True

    async def hover(self, file: str, line: int, character: int) -> dict | None:
        """Get hover information."""
        return None

    async def definition(self, file: str, line: int, character: int) -> list[dict] | None:
        """Go to definition."""
        return None

    async def references(self, file: str, line: int, character: int) -> list[dict] | None:
        """Find references."""
        return None

    async def rename(self, file: str, line: int, character: int, new_name: str) -> dict | None:
        """Rename symbol."""
        return None

    async def shutdown(self) -> None:
        """Shutdown LSP servers."""
        pass


class CodeAgent:
    """Main code agent with LangGraph workflow."""

    def __init__(
        self,
        project_root: Path | str,
        llm_orchestrator: LLMOrchestrator,
        codebase_indexer=None,
    ):
        self.project_root = Path(project_root).resolve()
        self.llm = llm_orchestrator
        self.files = FileOperations(self.project_root)
        self.git = GitOperations(self.project_root)
        self.lsp = LSPClient(self.project_root)
        # Optional codebase indexer (from memory module) for retrieval-augmented coding
        self.codebase_indexer = codebase_indexer

        self.settings = get_settings().agent
        self.max_tool_rounds = 5  # agentic tool-call rounds per plan step
        self._graph: CompiledStateGraph | None = None

        # Specialized skills
        self.generation_skill = CodeGenerationSkill(self)
        self.refactoring_skill = CodeRefactoringSkill(self)
        self.debugging_skill = CodeDebuggingSkill(self)
        self.testing_skill = CodeTestingSkill(self)
        self.explanation_skill = CodeExplanationSkill(self)

    def _build_graph(self) -> CompiledStateGraph:
        """Build LangGraph workflow."""
        graph = StateGraph(CodeState)

        # Nodes
        graph.add_node("analyze", self._analyze_task)
        graph.add_node("plan", self._create_plan)
        graph.add_node("execute", self._execute_step)
        graph.add_node("verify", self._verify_changes)
        graph.add_node("test", self._run_tests)
        graph.add_node("finalize", self._finalize)

        # Edges
        graph.add_edge("analyze", "plan")
        graph.add_edge("plan", "execute")
        graph.add_conditional_edges(
            "execute",
            self._should_continue,
            {"continue": "execute", "verify": "verify", "error": "finalize"},
        )
        graph.add_conditional_edges(
            "verify",
            self._verification_result,
            {"pass": "test", "fail": "execute", "skip_test": "finalize"},
        )
        graph.add_edge("test", "finalize")
        graph.add_edge("finalize", END)

        graph.set_entry_point("analyze")
        return graph.compile()

    async def _analyze_task(self, state: CodeState) -> CodeState:
        """Analyze the coding task with timing."""
        start_time = time.time()
        task = state.task

        # Determine language from context or task
        language = state.context.language if state.context else "python"

        # Build context
        context_info = ""
        if state.context:
            context_info = f"""
Project root: {state.context.project_root}
Current file: {state.context.current_file}
Language: {state.context.language}
Framework: {state.context.framework}
Related files: {', '.join(str(f) for f in state.context.related_files[:5])}
"""

        # Pull relevant existing code from the codebase index (if available)
        code_hits = ""
        if self.codebase_indexer is not None:
            try:
                results = await self.codebase_indexer.search_code(task, top_k=4)
                if results:
                    code_hits = "\n".join(
                        f"[{r.entry.metadata.get('file', 'unknown')}]\n{r.entry.content[:800]}"
                        for r in results
                    )
            except Exception as e:
                logger.debug(f"Codebase search unavailable: {e}")

        prompt = f"""Analyze this coding task and determine what needs to be done.

Task: {task}
{context_info}
{'Existing code that may be relevant:' + code_hits if code_hits else ''}

Identify:
1. Type of task (generate, refactor, debug, test, explain, review)
2. Scope (single file, multiple files, new project)
3. Key requirements and constraints
4. Potential challenges

Respond with a brief analysis."""

        request = LLMRequest(
            messages=[HumanMessage(content=prompt)],
            model_type=ModelType.CODER,
            temperature=0.2,
        )

        response = await self.llm.generate(request)

        state.messages.append(HumanMessage(content=task))
        state.messages.append(AIMessage(content=response.content))
        
        # Track analysis time
        if "step_times" not in state.execution_stats:
            state.execution_stats["step_times"] = {}
        state.execution_stats["step_times"]["analysis"] = time.time() - start_time

        return state

    async def _create_plan(self, state: CodeState) -> CodeState:
        """Create execution plan with timing."""
        start_time = time.time()
        task = state.task
        analysis = state.messages[-1].content if state.messages else ""

        prompt = f"""Create a step-by-step plan for this coding task.

Task: {task}
Analysis: {analysis}

Create a detailed plan with specific steps. Each step should be actionable.
Format as a numbered list."""

        request = LLMRequest(
            messages=[HumanMessage(content=prompt)],
            model_type=ModelType.CODER,
            temperature=0.2,
        )

        response = await self.llm.generate(request)

        # Parse plan steps
        plan_lines = response.content.strip().split("\n")
        state.plan = [
            line.strip().lstrip("0123456789. ")
            for line in plan_lines
            if line.strip() and any(line.strip().startswith(str(i)) for i in range(1, 20))
        ]

        if not state.plan:
            state.plan = [response.content]

        state.current_step = 0
        
        # Track planning time
        if "step_times" not in state.execution_stats:
            state.execution_stats["step_times"] = {}
        state.execution_stats["step_times"]["planning"] = time.time() - start_time

        return state

    async def _execute_step(self, state: CodeState) -> CodeState:
        """Execute current plan step with an agentic tool-use loop.

        Unlike a single-shot call, this runs the model against its tools
        repeatedly: the model may read files, edit, and run commands, then
        receive the results and continue until it produces a final answer
        or hits the iteration cap.
        """
        if state.current_step >= len(state.plan):
            return state

        step = state.plan[state.current_step]
        state.current_step += 1

        # Initialize execution stats (dict may already hold start_time from execute())
        if not state.execution_stats:
            state.execution_stats = {}
        state.execution_stats.setdefault("steps_started", 0)
        state.execution_stats.setdefault("steps_completed", 0)
        state.execution_stats.setdefault("tool_calls", 0)
        state.execution_stats.setdefault("tool_failures", 0)
        state.execution_stats.setdefault("start_time", time.time())
        state.execution_stats["steps_started"] += 1

        logger.info(f"Executing step {state.current_step}/{len(state.plan)}: {step}")

        # Build context for this step
        context = self._build_step_context(state)

        prompt = f"""Execute this step of the plan.

Step: {step}
Full task: {state.task}
Plan: {chr(10).join(f'{i+1}. {s}' for i, s in enumerate(state.plan))}
Completed steps: {state.current_step - 1}

Context:
{context}

Use the available tools to perform the necessary file operations, code changes, or commands.
Inspect results, and iterate if needed. When the step is complete, reply with a concise summary of what was done."""

        step_messages: list[BaseMessage] = [
            SystemMessage(content=self._coding_system_prompt()),
            HumanMessage(content=prompt),
        ]

        for round_num in range(self.max_tool_rounds):
            # Use retry and timeout decorators for LLM calls
            @retry(max_attempts=2, delay=1.0, backoff=2.0)
            @timeout(60.0)
            async def get_llm_response():
                request = LLMRequest(
                    messages=list(step_messages),
                    model_type=ModelType.CODER,
                    temperature=0.2,
                    tools=self._get_tools(),
                )
                return await self.llm.generate(request)

            try:
                response = await get_llm_response()
            except asyncio.TimeoutError:
                error_msg = f"Step execution timed out: {step}"
                state.errors.append(error_msg)
                state.messages.append(HumanMessage(content=f"Error: {error_msg}"))
                return state
            except Exception as e:
                error_msg = f"Step execution failed: {str(e)}"
                state.errors.append(error_msg)
                state.messages.append(HumanMessage(content=f"Error: {error_msg}"))
                state.execution_stats["tool_failures"] += 1
                return state

            tool_calls = list(getattr(response, "tool_calls", None) or [])

            # No tool calls -> the model produced its final answer for this step
            if not tool_calls:
                step_messages.append(AIMessage(content=response.content))
                state.messages.append(HumanMessage(content=f"Step: {step}"))
                state.messages.append(AIMessage(content=response.content))
                break

            # Feed tool calls + results back into the conversation so the
            # model can observe outcomes and decide what to do next.
            step_messages.append(AIMessage(content=response.content or "", tool_calls=tool_calls))
            state.messages.append(AIMessage(content=response.content or "", tool_calls=tool_calls))

            for tool_call in tool_calls:
                result = await self._execute_tool_call(tool_call, state)
                state.execution_stats["tool_calls"] += 1

                tool_call_id = tool_call.get("id") if isinstance(tool_call, dict) else getattr(tool_call, "id", None)
                tool_msg = ToolMessage(content=result, tool_call_id=tool_call_id or "")
                step_messages.append(tool_msg)
                state.messages.append(tool_msg)

            # Cap the agentic loop to prevent runaway tool use
            if round_num == self.max_tool_rounds - 1:
                state.messages.append(HumanMessage(
                    content=f"Reached the {self.max_tool_rounds}-round tool-use limit for this step; summarize what was done so far."
                ))

        state.execution_stats["steps_completed"] += 1
        return state

    def _coding_system_prompt(self) -> str:
        """System prompt for the code execution loop (includes installed skills)."""
        base = (
            "You are an expert software engineer operating inside the user's project. "
            "Work carefully and incrementally:\n"
            "1. Read files before editing them; never assume content you haven't seen.\n"
            "2. Prefer small, surgical edits over rewrites. Preserve existing style and conventions.\n"
            "3. After editing, run the appropriate checks (syntax check, linter, typecheck, tests) when possible.\n"
            "4. If a command fails, read the error, fix the cause, and retry rather than giving up.\n"
            "5. Only produce a final summary once the step's work is actually complete and verified.\n"
            "6. Never invent file contents or command output - use the tools to find out the truth.\n"
            "7. Keep paths relative to the project root.\n"
        )
        try:
            from jaa.skills import SkillManager
            skills = SkillManager().build_context()
            if skills:
                base += "\n\n" + skills
        except Exception:
            pass
        return base

    def _build_step_context(self, state: CodeState) -> str:
        """Build context for current step."""
        context_parts = []

        if state.context:
            if state.context.current_file:
                try:
                    content = self.files.read_file(str(state.context.current_file))
                    # Keep the file readable but cap size for context limits
                    context_parts.append(f"Current file ({state.context.current_file}):\n{content[:6000]}")
                except Exception:
                    pass

            for rel_file in state.context.related_files[:3]:
                try:
                    content = self.files.read_file(str(rel_file))
                    context_parts.append(f"Related file ({rel_file}):\n{content[:2000]}")
                except Exception:
                    pass

        return "\n\n".join(context_parts) if context_parts else "No additional context."

    def _get_tools(self) -> list[dict]:
        """Get available tools for LLM."""
        return [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file from the project",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Relative path to file"},
                        },
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Write content to a file",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Relative path to file"},
                            "content": {"type": "string", "description": "File content"},
                        },
                        "required": ["path", "content"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "edit_file",
                    "description": "Edit a file by replacing text",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Relative path to file"},
                            "old_text": {"type": "string", "description": "Text to replace"},
                            "new_text": {"type": "string", "description": "New text"},
                        },
                        "required": ["path", "old_text", "new_text"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "run_command",
                    "description": "Run a shell command in project root",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "command": {"type": "string", "description": "Command to run"},
                        },
                        "required": ["command"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "List files matching pattern",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "pattern": {"type": "string", "description": "Glob pattern", "default": "**/*"},
                        },
                    },
                },
            },
        ]

    async def _execute_tool_call(self, tool_call: dict, state: CodeState) -> str:
        """Execute a tool call from the LLM and return the result as text.

        Results are returned (not just logged) so the agentic loop can feed
        them back to the model as tool messages.
        """
        # LangChain tool calls: {"name": ..., "args": {...}}; OpenAI-style:
        # {"function": {"name": ..., "arguments": ...}}. Support both.
        if "function" in tool_call:
            name = tool_call.get("function", {}).get("name")
            args = tool_call.get("function", {}).get("arguments", {})
        else:
            name = tool_call.get("name")
            args = tool_call.get("args", {})

        if isinstance(args, str):
            import json
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                state.errors.append(f"Tool {name}: invalid arguments")
                return f"Error: invalid arguments for tool {name}"

        try:
            if name == "read_file":
                content = self.files.read_file(args["path"])
                if len(content) > 6000:
                    content = content[:6000] + "\n...[truncated]"
                return f"File {args['path']}:\n{content}"
            elif name == "write_file":
                self.files.write_file(args["path"], args["content"])
                state.files_modified.append(self.project_root / args["path"])
                return f"Written {len(args['content'])} chars to {args['path']}"
            elif name == "edit_file":
                self.files.edit_file(args["path"], args["old_text"], args["new_text"])
                state.files_modified.append(self.project_root / args["path"])
                return f"Edited {args['path']}"
            elif name == "run_command":
                output = self._run_safe_command(args["command"])
                return output
            elif name == "list_files":
                files = self.files.list_files(args.get("pattern", "**/*"))
                return f"Files ({len(files)}):\n{chr(10).join(files[:200])}"
            else:
                raise ValueError(f"Unknown tool: {name}")
        except Exception as e:
            error_msg = f"Tool {name} failed: {e}"
            state.errors.append(error_msg)
            state.last_error = error_msg
            logger.warning(error_msg)
            return f"Error: {error_msg}"

    def _run_safe_command(self, command: str) -> str:
        """Run a shell command, enforcing the security allowlist."""
        security = get_settings().security
        cmd_parts = command.strip().split()
        base_cmd = cmd_parts[0].lower() if cmd_parts else ""

        if base_cmd in security.blocked_commands:
            return f"Error: command '{base_cmd}' is blocked by JAA security settings."
        if security.allow_shell is False and base_cmd not in security.allowed_commands:
            return (
                f"Error: command '{base_cmd}' is not in the allowed list. "
                f"Add it to JAA_SECURITY_ALLOWED_COMMANDS or set JAA_SECURITY_ALLOW_SHELL=true to allow shell commands."
            )

        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=self.project_root,
                capture_output=True,
                text=True,
                timeout=120,
            )
            output = f"Exit code: {result.returncode}\nStdout:\n{result.stdout[:4000]}\nStderr:\n{result.stderr[:4000]}"
            return output
        except subprocess.TimeoutExpired:
            return "Error: command timed out after 120 seconds"
        except Exception as e:
            return f"Error: command failed: {e}"

    def _should_continue(self, state: CodeState) -> str:
        """Determine if should continue executing steps."""
        if state.errors:
            return "error"
        if state.current_step < len(state.plan):
            return "continue"
        return "verify"

    async def _verify_changes(self, state: CodeState) -> CodeState:
        """Verify changes are correct with enhanced validation."""
        if not state.files_modified:
            return state

        # Track verification attempts
        verification_key = f"verify:{len(state.files_modified)}"
        verification_attempts = state.execution_stats.get("verification_attempts", 0) + 1
        state.execution_stats["verification_attempts"] = verification_attempts

        # Build detailed verification prompt
        files_list = ", ".join(str(f) for f in state.files_modified)
        plan_steps = chr(10).join(state.plan)
        
        prompt = f"""Verify the changes made for this task with strict attention to detail.

Task: {state.task}
Files modified: {files_list}
Plan followed: 
{plan_steps}

Perform comprehensive verification:
1. Syntax Check: Verify all modified files have valid syntax for their language
2. Semantic Check: Ensure changes logically address the original task
3. Completeness Check: Confirm all plan steps were executed
4. Quality Check: Look for obvious bugs, security issues, or poor practices
5. Consistency Check: Verify code follows project conventions and style

For each file, provide specific feedback. If all checks pass, respond with "PASS".
If there are issues, list them clearly with file names and line numbers when possible."""

        request = LLMRequest(
            messages=[HumanMessage(content=prompt)],
            model_type=ModelType.CODER,
            temperature=0.1,  # Lower temperature for more consistent validation
        )

        response = await self.llm.generate(request)

        # Check if verification passed
        if "PASS" in response.content.upper():
            state.messages.append(HumanMessage(content=f"Verification: PASS (attempt {verification_attempts})"))
            # Reset verification attempts on success
            if "verification_attempts" in state.execution_stats:
                del state.execution_stats["verification_attempts"]
        else:
            error_msg = f"Verification failed (attempt {verification_attempts}): {response.content}"
            state.messages.append(HumanMessage(content=error_msg))
            state.errors.append(error_msg)
            
            # Limit verification attempts to prevent infinite loops
            if verification_attempts >= 3:
                # After 3 attempts, proceed anyway but warn
                warning_msg = "Warning: Proceeding after 3 failed verification attempts"
                state.messages.append(HumanMessage(content=warning_msg))
                # Clear errors to allow continuation
                state.errors = [e for e in state.errors if "Verification failed" not in e]
                state.errors.append(warning_msg)

        return state

    def _verification_result(self, state: CodeState) -> str:
        """Determine verification result."""
        if state.errors:
            return "fail"
        if self.settings and self.settings.code_auto_test:
            return "pass"
        return "skip_test"

    async def _run_tests(self, state: CodeState) -> CodeState:
        """Run tests to verify changes with enhanced framework detection."""
        if not self.settings:
            return state

        # Initialize test stats if not present
        if "test_stats" not in state.execution_stats:
            state.execution_stats["test_stats"] = {
                "tests_run": 0,
                "tests_passed": 0,
                "tests_failed": 0,
                "framework_detected": None
            }

        # Auto-detect test framework based on project files
        test_cmd = await self._detect_and_configure_test_command(state)
        
        try:
            result = subprocess.run(
                test_cmd,
                shell=True,
                cwd=self.project_root,
                capture_output=True,
                text=True,
                timeout=120,
            )
            state.tests_run = True
            state.test_results = f"Exit code: {result.returncode}\n{result.stdout}\n{result.stderr}"

            # Update test statistics
            test_stats = state.execution_stats["test_stats"]
            test_stats["tests_run"] += 1
            if result.returncode == 0:
                test_stats["tests_passed"] += 1
            else:
                test_stats["tests_failed"] += 1
                error_msg = f"Tests failed: {result.stdout[:500]}"
                state.errors.append(error_msg)

        except subprocess.TimeoutExpired:
            error_msg = "Test execution timed out after 120 seconds"
            state.errors.append(error_msg)
            state.test_results = error_msg
        except Exception as e:
            error_msg = f"Test execution failed: {e}"
            state.errors.append(error_msg)
            state.test_results = error_msg

        return state

    async def _detect_and_configure_test_command(self, state: CodeState) -> str:
        """Detect testing framework and configure appropriate test command."""
        # Start with configured command
        base_cmd = self.settings.code_test_command if self.settings.code_test_command else "pytest -xvs"
        
        # Check what test files exist to determine framework
        test_indicators = {
            "pytest": ["test_*.py", "*_test.py", "tests/"],
            "unittest": ["test*.py"],
            "jest": ["*.test.js", "*.spec.js", "__tests__/"],
            "mocha": ["*.test.js", "*.spec.js"],
            "jasmine": ["*spec.js", "*Spec.js"],
            "go_test": ["*_test.go"],
            "rust_test": ["tests/", "benches/"],
            "junit": ["*Test.java", "*Tests.java"],
            "nunit": ["*Test.cs", "*Tests.cs"],
            "xunit": ["*Test.cs", "*Tests.cs"]
        }
        
        # Check for existing test files to override default command
        for framework, patterns in test_indicators.items():
            for pattern in patterns:
                # Handle directory patterns
                if pattern.endswith("/"):
                    dir_path = self.project_root / pattern[:-1]
                    if dir_path.exists() and dir_path.is_dir():
                        # Found test directory, use appropriate command
                        if framework == "pytest":
                            return "pytest -xvs"
                        elif framework == "junit":
                            return "mvn test"
                        elif framework == "nunit" or framework == "xunit":
                            return "dotnet test"
                else:
                    # Handle file patterns
                    test_files = list(self.project_root.rglob(pattern))
                    if test_files:
                        if framework == "pytest":
                            return "pytest -xvs"
                        elif framework == "jest" or framework == "mocha" or framework == "jasmine":
                            return "npm test"
                        elif framework == "go_test":
                            return "go test ./..."
                        elif framework == "rust_test":
                            return "cargo test"
        
        return base_cmd

    async def _finalize(self, state: CodeState) -> CodeState:
        """Finalize and produce comprehensive output."""
        # Calculate execution time
        execution_time = 0
        if state.execution_stats and "start_time" in state.execution_stats:
            execution_time = time.time() - state.execution_stats["start_time"]

        if state.errors:
            error_summary = "\n".join(state.errors)
            state.final_output = f"Task completed with errors after {execution_time:.2f}s:\n{error_summary}"
            
            # Add execution stats if available
            if state.execution_stats:
                stats_lines = []
                for key, value in state.execution_stats.items():
                    if key != "start_time":
                        stats_lines.append(f"  {key}: {value}")
                if stats_lines:
                    state.final_output += f"\n\nExecution Statistics:\n" + "\n".join(stats_lines)
        else:
            success_msg = f"Task completed successfully in {execution_time:.2f}s"
            files_msg = f"Modified files: {', '.join(str(f) for f in state.files_modified) if state.files_modified else 'None'}"
            
            state.final_output = f"{success_msg}\n{files_msg}"
            
            if state.tests_run:
                test_status = "PASSED" if not state.errors else "FAILED"
                state.final_output += f"\nTests: {test_status}"
                
                # Add test statistics if available
                if "test_stats" in state.execution_stats:
                    test_stats = state.execution_stats["test_stats"]
                    if test_stats["tests_run"] > 0:
                        state.final_output += f" ({test_stats['tests_passed']}/{test_stats['tests_run']} passed)"
            
            # Add execution stats
            if state.execution_stats:
                stats_lines = []
                for key, value in state.execution_stats.items():
                    if key not in ["start_time", "test_stats"]:
                        stats_lines.append(f"  {key}: {value}")
                if stats_lines:
                    state.final_output += f"\n\nExecution Statistics:\n" + "\n".join(stats_lines)

        return state

    async def execute(self, task: str, context: CodeContext | None = None) -> str:
        """Execute a coding task with performance tracking."""
        if self._graph is None:
            self._graph = self._build_graph()

        initial_state = CodeState(
            task=task,
            context=context,
        )
        
        # Initialize execution timing
        initial_state.execution_stats = {"start_time": time.time()}

        final_state = await self._graph.ainvoke(initial_state)
        return final_state.get("final_output", "No output")


# Specialized skill classes
class CodeGenerationSkill:
    """Skill for generating new code from specifications."""

    def __init__(self, agent: CodeAgent):
        self.agent = agent

    async def generate(
        self,
        spec: str,
        language: str = "python",
        framework: str | None = None,
        output_path: str | None = None,
    ) -> str:
        """Generate code from specification."""
        task = f"Generate {language} code for: {spec}"
        if framework:
            task += f" using {framework}"

        context = CodeContext(
            project_root=self.agent.project_root,
            language=language,
            framework=framework,
        )

        return await self.agent.execute(task, context)


class CodeRefactoringSkill:
    """Skill for refactoring existing code."""

    def __init__(self, agent: CodeAgent):
        self.agent = agent

    async def refactor(
        self,
        file_path: str,
        goal: str,
        context_files: list[str] | None = None,
    ) -> str:
        """Refactor code in a file."""
        task = f"Refactor {file_path} to {goal}"

        context = CodeContext(
            project_root=self.agent.project_root,
            current_file=self.agent.project_root / file_path,
            related_files=[self.agent.project_root / f for f in (context_files or [])],
        )

        return await self.agent.execute(task, context)


class CodeDebuggingSkill:
    """Skill for debugging code issues."""

    def __init__(self, agent: CodeAgent):
        self.agent = agent

    async def debug(
        self,
        error_message: str,
        file_path: str | None = None,
        test_command: str | None = None,
    ) -> str:
        """Debug an error."""
        task = f"Debug error: {error_message}"
        if file_path:
            task += f" in {file_path}"
        if test_command:
            task += f" (reproduce with: {test_command})"

        context = CodeContext(
            project_root=self.agent.project_root,
            current_file=self.agent.project_root / file_path if file_path else None,
        )

        return await self.agent.execute(task, context)


class CodeTestingSkill:
    """Skill for generating and running tests."""

    def __init__(self, agent: CodeAgent):
        self.agent = agent

    async def generate_tests(
        self,
        file_path: str,
        test_type: str = "unit",
        framework: str = "pytest",
    ) -> str:
        """Generate tests for a file."""
        task = f"Generate {test_type} tests for {file_path} using {framework}"

        context = CodeContext(
            project_root=self.agent.project_root,
            current_file=self.agent.project_root / file_path,
        )

        return await self.agent.execute(task, context)

    async def run_tests(self, path: str | None = None) -> str:
        """Run tests."""
        test_cmd = self.agent.settings.code_test_command if self.agent.settings else "pytest -xvs"
        if path:
            test_cmd += f" {path}"

        result = subprocess.run(
            test_cmd,
            shell=True,
            cwd=self.agent.project_root,
            capture_output=True,
            text=True,
            timeout=120,
        )

        return f"Exit code: {result.returncode}\n{result.stdout}\n{result.stderr}"


class CodeExplanationSkill:
    """Skill for explaining code."""

    def __init__(self, agent: CodeAgent):
        self.agent = agent

    async def explain(self, file_path: str, focus: str | None = None) -> str:
        """Explain code in a file."""
        task = f"Explain the code in {file_path}"
        if focus:
            task += f" focusing on {focus}"

        context = CodeContext(
            project_root=self.agent.project_root,
            current_file=self.agent.project_root / file_path,
        )

        return await self.agent.execute(task, context)