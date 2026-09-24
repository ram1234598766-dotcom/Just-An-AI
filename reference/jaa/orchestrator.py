"""
Core orchestrator for J.A.A.

Main entry point that coordinates voice, LLM, agents, memory, and NLP.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from jaa.config.settings import Settings, get_settings
from jaa.llm import LLMOrchestrator, LLMRequest, ModelType
from jaa.nlp import (
    ConversationManager,
    HybridIntentClassifier,
    IntentResult,
    IntentCategory,
    CommandParser,
)
from jaa.memory import MemoryManager
from jaa.agents import CodeAgent, DesktopAgent, SystemAgent, ToolAgent

logger = logging.getLogger(__name__)


@dataclass
class JAAContext:
    """Context passed through the pipeline."""
    user_input: str
    intent: IntentResult | None = None
    command: dict | None = None
    response: str | None = None
    voice_mode: bool = False
    session_id: str = ""
    metadata: dict = field(default_factory=dict)


class JAAOrchestrator:
    """Main J.A.A. orchestrator."""

    def __init__(self, project_root: Path | None = None):
        self.settings = get_settings()
        self.project_root = project_root or Path.cwd()

        # Core components
        self.llm = LLMOrchestrator(self.settings.llm)
        self.memory = MemoryManager(self.project_root)
        # Conversations persist to ~/.jaa/memory/sessions.db (resume with `jaa chat --resume`)
        self.conversation = ConversationManager(project_root=str(self.project_root))

        # NLP pipeline
        self.intent_classifier = HybridIntentClassifier(self.llm)
        self.command_parser = CommandParser(self.llm)

        # Agents (code agent gets the codebase indexer for repo-aware coding)
        self.code_agent = CodeAgent(self.project_root, self.llm, codebase_indexer=self.memory.codebase_indexer)
        self.desktop_agent = DesktopAgent(self.settings.agent)
        self.system_agent = SystemAgent(self.settings.agent)
        self.tool_agent = ToolAgent(self.llm, self.project_root)

        # Voice (typed loosely to avoid importing audio deps at module load)
        self.voice: Any | None = None

        # State
        self._running = False
        self._shutdown_event = asyncio.Event()

    async def initialize(self) -> None:
        """Initialize all components."""
        logger.info("Initializing J.A.A. ...")

        # Initialize LLM
        await self.llm.initialize()

        # Initialize memory
        await self.memory.initialize()

        # Initialize voice if enabled, but defer import to avoid optional audio dependency issues.
        if self.settings.voice.stt_engine:
            try:
                from jaa.voice import VoicePipeline

                self.voice = VoicePipeline(self.settings.voice)
                await self.voice.initialize()
            except Exception as e:
                logger.warning(f"Voice pipeline could not be initialized: {e}")
                self.voice = None

        # Setup signal handlers
        self._setup_signals()

        self._running = True
        logger.info("J.A.A. initialized successfully")

    def _setup_signals(self) -> None:
        """Setup signal handlers for graceful shutdown."""
        try:
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, self._shutdown)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass

    def _shutdown(self) -> None:
        """Signal shutdown."""
        logger.info("Shutdown signal received")
        self._running = False
        self._shutdown_event.set()

    async def process_text(self, text: str, voice_mode: bool = False) -> str:
        """Process text input through full pipeline."""
        chunks = []
        async for chunk in self.process_text_stream(text, voice_mode=voice_mode):
            chunks.append(chunk)
        return "".join(chunks)

    async def process_text_stream(self, text: str, voice_mode: bool = False):
        """Process text input and yield response chunks for streaming."""
        context = JAAContext(
            user_input=text,
            voice_mode=voice_mode,
            session_id=self.conversation.get_active_task() or "default",
        )

        try:
            self.conversation.add_user_message(text)
            context.intent = await self.intent_classifier.classify(
                text,
                {"session_context": self.conversation.get_summary()},
            )
            logger.debug(f"Intent: {context.intent.category.value} (confidence: {context.intent.confidence:.2f})")
            context.command = await self.command_parser.parse(text, context.intent)

            response_text = ""
            async for chunk in self._execute_intent_stream(context):
                response_text += chunk
                yield chunk

            context.response = response_text
            self.conversation.add_assistant_message(context.response)
            await asyncio.to_thread(self.conversation.save)
            await self.memory.add_conversation_turn("user", text)
            await self.memory.add_conversation_turn("assistant", context.response)

        except Exception as e:
            logger.exception(f"Error processing input: {e}")
            error_response = f"I encountered an error: {str(e)}"
            self.conversation.add_assistant_message(error_response)
            yield error_response

    async def _execute_intent_stream(self, context: JAAContext):
        """Execute intent and yield response chunks."""
        intent = context.intent
        command = context.command

        if not intent or intent.category == IntentCategory.UNKNOWN:
            response = await self._handle_general_query(context.user_input)
            yield response
            return

        if intent.category.value.startswith("code_"):
            response = await self._handle_code_intent(context)
        elif intent.category.value.startswith("desktop_"):
            response = await self._handle_desktop_intent(context)
        elif intent.category.value.startswith("file_"):
            response = await self._handle_file_intent(context)
        elif intent.category.value.startswith("system_"):
            response = await self._handle_system_intent(context)
        elif intent.category.value.startswith("query_"):
            response = await self._handle_query_intent(context)
        elif intent.category.value.startswith("control_"):
            response = await self._handle_control_intent(context)
        else:
            response = await self._handle_general_query(context.user_input)
        yield response

    async def _execute_intent(self, context: JAAContext) -> str:
        """Execute action based on classified intent."""
        intent = context.intent
        command = context.command

        if not intent or intent.category == IntentCategory.UNKNOWN:
            return await self._handle_general_query(context.user_input)

        # Route to appropriate handler
        if intent.category.value.startswith("code_"):
            return await self._handle_code_intent(context)
        elif intent.category.value.startswith("desktop_"):
            return await self._handle_desktop_intent(context)
        elif intent.category.value.startswith("file_"):
            return await self._handle_file_intent(context)
        elif intent.category.value.startswith("system_"):
            return await self._handle_system_intent(context)
        elif intent.category.value.startswith("query_"):
            return await self._handle_query_intent(context)
        elif intent.category.value.startswith("control_"):
            return await self._handle_control_intent(context)
        else:
            return await self._handle_general_query(context.user_input)

    @staticmethod
    def _entity_value(intent: IntentResult, role: str, default: str = "") -> str:
        """Get an entity value by role (from rule metadata) or entity type."""
        for e in intent.entities:
            if e.metadata.get("role") == role or e.type.value == role:
                return e.value
        return default

    async def _handle_code_intent(self, context: JAAContext) -> str:
        """Handle code-related intents."""
        intent = context.intent
        command = context.command or {}
        params = command.get("parameters", {})

        # Build code context
        from jaa.agents.code_agent import CodeContext

        code_context = CodeContext(project_root=self.project_root)

        # Extract file path from entities
        file_path = self._entity_value(intent, "file_path")
        if file_path:
            code_context.current_file = self.project_root / file_path

        current_file_str = str(code_context.current_file) if code_context.current_file else ""

        # Execute based on specific intent
        if intent.category == IntentCategory.CODE_GENERATE:
            return await self.code_agent.generation_skill.generate(
                params.get("requirements", context.user_input),
                params.get("language", "python"),
                params.get("framework"),
            )
        elif intent.category == IntentCategory.CODE_REFACTOR:
            return await self.code_agent.refactoring_skill.refactor(
                current_file_str,
                params.get("goal", context.user_input),
            )
        elif intent.category == IntentCategory.CODE_DEBUG:
            return await self.code_agent.debugging_skill.debug(
                params.get("error_message", context.user_input),
                current_file_str or None,
            )
        elif intent.category == IntentCategory.CODE_TEST:
            return await self.code_agent.testing_skill.generate_tests(current_file_str)
        elif intent.category == IntentCategory.CODE_EXPLAIN:
            return await self.code_agent.explanation_skill.explain(current_file_str)
        else:
            # General code task
            return await self.code_agent.execute(context.user_input, code_context)

    async def _handle_desktop_intent(self, context: JAAContext) -> str:
        """Handle desktop automation intents."""
        intent = context.intent
        command = context.command or {}
        params = command.get("parameters", {})

        if intent.category == IntentCategory.DESKTOP_OPEN:
            app_name = params.get("app_name") or self._entity_value(intent, "app_name")
            if app_name:
                success = await self.desktop_agent.apps.launch(app_name)
                return f"Opened {app_name}" if success else f"Failed to open {app_name}"
            return "Which application should I open?"

        elif intent.category == IntentCategory.DESKTOP_CLOSE:
            app_name = params.get("app_name") or self._entity_value(intent, "app_name")
            if app_name:
                success = await self.desktop_agent.apps.close(app_name)
                return f"Closed {app_name}" if success else f"Failed to close {app_name}"
            return "Which application should I close?"

        elif intent.category == IntentCategory.DESKTOP_SWITCH:
            app_name = params.get("app_name") or self._entity_value(intent, "app_name")
            if app_name:
                success = await self.desktop_agent.switch_to_app(app_name)
                return f"Switched to {app_name}" if success else f"Could not find {app_name}"
            return "Which application should I switch to?"

        elif intent.category == IntentCategory.DESKTOP_ARRANGE:
            # Arrange windows
            windows = await self.desktop_agent.windows.list_windows()
            # Simple arrangement - tile up to 4 visible windows
            positions = ["topleft", "topright", "bottomleft", "bottomright"]
            visible = [w for w in windows if w.is_visible and not w.is_minimized]
            for i, win in enumerate(visible[:4]):
                await self.desktop_agent.windows.snap_window(win, positions[i])
            return f"Arranged {min(len(visible), 4)} windows"

        elif intent.category == IntentCategory.DESKTOP_TYPE:
            text = params.get("text") or self._entity_value(intent, "text")
            if text:
                await self.desktop_agent.input.type_text(text)
                return f"Typed: {text[:50]}"
            return "What should I type?"

        elif intent.category == IntentCategory.DESKTOP_SHORTCUT:
            keys = params.get("keys") or self._entity_value(intent, "keys")
            if keys:
                await self.desktop_agent.input.press_keys(keys)
                return f"Pressed: {keys}"
            return "Which shortcut should I press?"

        elif intent.category == IntentCategory.DESKTOP_CLICK:
            # Would need coordinates or target
            return "Click action requires coordinates or target element"

        elif intent.category == IntentCategory.DESKTOP_SCREENSHOT:
            screenshot = await self.desktop_agent.screen.capture()
            return f"Screenshot saved to {screenshot}"

        return "Desktop action completed"

    def _recent_conversation(self) -> str:
        """Recent exchange history for multi-turn continuity ("" if none)."""
        summary = self.conversation.get_summary()
        if summary and summary != "No conversation history.":
            return summary
        return ""

    async def _handle_file_intent(self, context: JAAContext) -> str:
        """Handle file operation intents."""
        intent = context.intent
        command = context.command or {}
        params = command.get("parameters", {})

        if intent.category == IntentCategory.FILE_CREATE:
            path = params.get("path") or self._entity_value(intent, "path") or self._entity_value(intent, "file_path")
            if path:
                try:
                    self.code_agent.files.write_file(path, params.get("content", "") or "")
                    return f"Created {path}"
                except Exception as e:
                    return f"Error creating file: {e}"
            return "Which file should I create?"

        elif intent.category == IntentCategory.FILE_DELETE:
            path = params.get("path") or self._entity_value(intent, "path") or self._entity_value(intent, "file_path")
            if path:
                try:
                    self.code_agent.files.delete_file(path)
                    return f"Deleted {path}"
                except Exception as e:
                    return f"Error deleting file: {e}"
            return "Which file should I delete?"

        elif intent.category == IntentCategory.FILE_MOVE:
            src = params.get("src") or self._entity_value(intent, "src")
            dst = params.get("dst") or self._entity_value(intent, "dst")
            if src and dst:
                try:
                    self.code_agent.files.move_file(src, dst)
                    return f"Moved {src} to {dst}"
                except Exception as e:
                    return f"Error moving file: {e}"
            return "I need both the source and destination paths to move a file."

        elif intent.category == IntentCategory.FILE_COPY:
            src = params.get("src") or self._entity_value(intent, "src")
            dst = params.get("dst") or self._entity_value(intent, "dst")
            if src and dst:
                try:
                    self.code_agent.files.copy_file(src, dst)
                    return f"Copied {src} to {dst}"
                except Exception as e:
                    return f"Error copying file: {e}"
            return "I need both the source and destination paths to copy a file."

        if intent.category == IntentCategory.FILE_READ:
            path = params.get("path") or self._entity_value(intent, "path") or self._entity_value(intent, "file_path")
            if path:
                try:
                    content = self.code_agent.files.read_file(path)
                    return f"File content:\n{content[:3000]}"
                except Exception as e:
                    return f"Error reading file: {e}"
            return "Which file should I read?"

        elif intent.category == IntentCategory.FILE_WRITE:
            path = params.get("path") or self._entity_value(intent, "path")
            content = params.get("content")
            if path and content is not None:
                try:
                    self.code_agent.files.write_file(path, content)
                    return f"Written to {path}"
                except Exception as e:
                    return f"Error writing file: {e}"
            return "I need both a file path and content to write."

        elif intent.category == IntentCategory.FILE_SEARCH:
            pattern = params.get("pattern") or self._entity_value(intent, "pattern", "*")
            directory = params.get("directory") or "."
            try:
                files = self.code_agent.files.glob(f"{directory}/**/{pattern}")
                return f"Found {len(files)} files:\n" + "\n".join(files[:20])
            except Exception as e:
                return f"Error searching files: {e}"

        elif intent.category == IntentCategory.FILE_ORGANIZE:
            try:
                moved = await self.desktop_agent.files.organize_downloads()
                total = sum(moved.values())
                if total:
                    summary = ", ".join(f"{cat}: {n}" for cat, n in moved.items() if n)
                    return f"Organized Downloads folder ({total} files: {summary})"
                return "Downloads folder is already organized"
            except Exception as e:
                return f"Error organizing downloads: {e}"

        return "File operation completed"

    async def _handle_system_intent(self, context: JAAContext) -> str:
        """Handle system information intents."""
        intent = context.intent

        if intent.category == IntentCategory.SYSTEM_INFO:
            status = await self.system_agent.get_system_status()
            return self._format_system_status(status)

        elif intent.category == IntentCategory.SYSTEM_PROCESS:
            processes = await self.system_agent.list_top_processes(10)
            return "Top processes:\n" + "\n".join(
                f"  {p['pid']}: {p['name']} - CPU: {p['cpu_percent']:.1f}% - Mem: {p['memory_mb']:.1f}MB"
                for p in processes
            )

        elif intent.category == IntentCategory.SYSTEM_NETWORK:
            # Check common ports
            ports = [80, 443, 22, 3306, 5432, 6379, 8080, 3000, 5000, 8000]
            results = []
            for port in ports:
                check = await self.system_agent.check_port(port)
                if check["in_use"]:
                    results.append(f"Port {port}: IN USE by {check['process'].get('name', 'unknown')}")
            return "Network ports:\n" + "\n".join(results) if results else "No common ports in use"

        return "System query completed"

    def _format_system_status(self, status: dict) -> str:
        """Format system status for display."""
        lines = ["System Status:"]
        lines.append(f"  Platform: {status['system']['platform']}")
        lines.append(f"  Hostname: {status['system']['hostname']}")
        lines.append(f"  Uptime: {status['system']['uptime_seconds']:.0f}s")
        lines.append(f"  CPU: {status['cpu']['total']:.1f}% total ({len(status['cpu']['per_core'])} cores)")
        lines.append(f"  Memory: {status['memory']['percent']:.1f}% used ({status['memory']['used']/1e9:.1f}/{status['memory']['total']/1e9:.1f} GB)")
        lines.append(f"  Disk: {status['disk']['percent']:.1f}% used ({status['disk']['used']/1e9:.1f}/{status['disk']['total']/1e9:.1f} GB)")
        return "\n".join(lines)

    async def _handle_query_intent(self, context: JAAContext) -> str:
        """Handle general query intents."""
        memory_context = await self.memory.build_context(context.user_input)
        recent = self._recent_conversation()
        task = f"Context from memory:\n{memory_context}\n\nUser question: {context.user_input}"
        if recent:
            task = f"Recent conversation:\n{recent}\n\n{task}"
        if context.intent.category == IntentCategory.QUERY_WEB:
            task = f"Search the web for: {context.user_input}\n" + task
        chunks = []
        async for chunk in self.tool_agent.stream(task):
            chunks.append(chunk)
        return "".join(chunks)

    async def _handle_control_intent(self, context: JAAContext) -> str:
        """Handle control intents."""
        intent = context.intent

        if intent.category == IntentCategory.CONTROL_STOP:
            self._shutdown()
            return "Shutting down J.A.A. ..."
        elif intent.category == IntentCategory.CONTROL_PAUSE:
            return "Paused. Say 'resume' to continue."
        elif intent.category == IntentCategory.CONTROL_RESUME:
            return "Resumed."
        elif intent.category == IntentCategory.CONTROL_REPEAT:
            # Repeat last action
            return "Repeating last action... (not implemented yet)"

        return "Control command processed"

    async def _handle_general_query(self, text: str) -> str:
        """Handle general conversation."""
        memory_context = await self.memory.build_context(text)
        recent = self._recent_conversation()
        task = f"""You are J.A.A. (Just An AI Assistant), a helpful, knowledgeable AI assistant.
You help with coding, desktop automation, system tasks, and general questions.
Use tools when helpful.

Context from memory:
{memory_context}
{f'Recent conversation:\n{recent}' if recent else ''}

User: {text}"""
        chunks = []
        async for chunk in self.tool_agent.stream(task):
            chunks.append(chunk)
        return "".join(chunks)

    async def run_voice_mode(self) -> None:
        """Run continuous voice interaction mode."""
        if not self.voice:
            raise RuntimeError("Voice pipeline not initialized")

        logger.info("Starting voice mode...")
        print("🎤 Voice mode active. Say 'Hey JAA' to activate.")

        async for transcription in self.voice.start_listening():
            if transcription.text.strip():
                print(f"👤 You: {transcription.text}")

                response = await self.process_text(transcription.text, voice_mode=True)

                print(f"🤖 J.A.A.: {response}")

                if self.voice:
                    await self.voice.speak(response)

    async def run_cli_mode(self) -> None:
        """Run interactive CLI mode."""
        print("🤖 J.A.A. (Just An AI Assistant) - CLI Mode")
        print("Type 'exit' or 'quit' to leave, 'help' for commands.\n")

        while self._running:
            try:
                # Don't block the event loop on stdin
                user_input = (await asyncio.to_thread(input, "👤 You: ")).strip()

                if user_input.lower() in ("exit", "quit", "bye"):
                    print("👋 Goodbye!")
                    break

                if user_input.lower() in ("help", "?"):
                    self._print_help()
                    continue

                if not user_input:
                    continue

                response = await self.process_text(user_input)
                print(f"🤖 J.A.A.: {response}\n")

            except KeyboardInterrupt:
                print("\n👋 Goodbye!")
                break
            except EOFError:
                break
            except Exception as e:
                logger.exception(f"Error in CLI loop: {e}")
                print(f"❌ Error: {e}")

    def _print_help(self) -> None:
        """Print help message."""
        help_text = """
Available Commands:
  help, ?          - Show this help
  exit, quit, bye  - Exit J.A.A.
  voice            - Switch to voice mode
  clear            - Clear conversation history
  memory           - Show memory stats
  status           - Show system status
  code <task>      - Code assistance
  desktop <action> - Desktop automation
  file <action>    - File operations
  system <query>   - System information

Examples:
  "Create a Python function to parse JSON"
  "Open VS Code"
  "Organize my downloads folder"
  "What's my CPU usage?"
  "Explain this code file"
"""
        print(help_text)

    async def shutdown(self) -> None:
        """Graceful shutdown."""
        logger.info("Shutting down J.A.A. ...")
        self._running = False

        if self.voice:
            await self.voice.shutdown()

        await self.llm.shutdown()
        logger.info("J.A.A. shutdown complete")


# Backward compatibility
class Orchestrator:
    """Legacy orchestrator interface."""

    def __init__(self, project_root: Path | None = None):
        self.orchestrator = JAAOrchestrator(project_root)

    async def initialize(self) -> None:
        await self.orchestrator.initialize()

    async def process(self, text: str) -> str:
        return await self.orchestrator.process_text(text)

    async def shutdown(self) -> None:
        await self.orchestrator.shutdown()