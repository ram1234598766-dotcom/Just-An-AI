"""
Desktop Agent for J.A.A.

Provides window management, input automation, app control,
file operations, and screen interaction capabilities.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import psutil
import pyautogui
import pynput
from pynput import keyboard, mouse
from screeninfo import get_monitors

from jaa.config.settings import AgentSettings, get_settings

logger = logging.getLogger(__name__)

# Configure pyautogui
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.1


@dataclass
class WindowInfo:
    """Information about a window."""
    title: str
    handle: int
    rect: tuple[int, int, int, int]  # left, top, right, bottom
    process_name: str
    process_id: int
    is_visible: bool
    is_minimized: bool
    is_maximized: bool


@dataclass
class ScreenRegion:
    """Screen region coordinates."""
    x: int
    y: int
    width: int
    height: int

    @property
    def left(self) -> int:
        return self.x

    @property
    def top(self) -> int:
        return self.y

    @property
    def right(self) -> int:
        return self.x + self.width

    @property
    def bottom(self) -> int:
        return self.y + self.height

    def to_tuple(self) -> tuple[int, int, int, int]:
        return (self.left, self.top, self.right, self.bottom)


@dataclass
class DesktopAction:
    """Record of a desktop action for replay."""
    action_type: str
    timestamp: float
    params: dict
    result: Any = None
    error: str | None = None


class WindowManager(ABC):
    """Abstract window management interface."""

    @abstractmethod
    async def list_windows(self) -> list[WindowInfo]:
        """List all visible windows."""
        pass

    @abstractmethod
    async def find_window(self, title_pattern: str) -> list[WindowInfo]:
        """Find windows matching title pattern."""
        pass

    @abstractmethod
    async def focus_window(self, window: WindowInfo) -> bool:
        """Bring window to foreground."""
        pass

    @abstractmethod
    async def move_window(self, window: WindowInfo, x: int, y: int, width: int | None = None, height: int | None = None) -> bool:
        """Move and optionally resize window."""
        pass

    @abstractmethod
    async def minimize_window(self, window: WindowInfo) -> bool:
        """Minimize window."""
        pass

    @abstractmethod
    async def maximize_window(self, window: WindowInfo) -> bool:
        """Maximize window."""
        pass

    @abstractmethod
    async def close_window(self, window: WindowInfo) -> bool:
        """Close window."""
        pass

    @abstractmethod
    async def snap_window(self, window: WindowInfo, position: str) -> bool:
        """Snap window to screen position (left, right, top, bottom, corners)."""
        pass


class WindowsWindowManager(WindowManager):
    """Windows-specific window management using pywin32."""

    def __init__(self):
        try:
            import win32gui
            import win32con
            import win32process
            import win32api
            self.win32gui = win32gui
            self.win32con = win32con
            self.win32process = win32process
            self.win32api = win32api
            self._available = True
        except ImportError:
            self._available = False
            logger.warning("pywin32 not available, Windows window management disabled")

    def _is_available(self) -> bool:
        return self._available

    async def list_windows(self) -> list[WindowInfo]:
        if not self._available:
            return []

        windows = []

        def enum_callback(hwnd, _):
            if not self.win32gui.IsWindowVisible(hwnd):
                return True

            title = self.win32gui.GetWindowText(hwnd)
            if not title:
                return True

            try:
                _, pid = self.win32process.GetWindowThreadProcessId(hwnd)
                process = psutil.Process(pid)
                process_name = process.name()
            except Exception:
                process_name = "unknown"
                pid = 0

            rect = self.win32gui.GetWindowRect(hwnd)
            placement = self.win32gui.GetWindowPlacement(hwnd)
            is_minimized = placement[1] == self.win32con.SW_SHOWMINIMIZED
            is_maximized = placement[1] == self.win32con.SW_SHOWMAXIMIZED

            windows.append(WindowInfo(
                title=title,
                handle=hwnd,
                rect=rect,
                process_name=process_name,
                process_id=pid,
                is_visible=True,
                is_minimized=is_minimized,
                is_maximized=is_maximized,
            ))
            return True

        self.win32gui.EnumWindows(enum_callback, None)
        return windows

    async def find_window(self, title_pattern: str) -> list[WindowInfo]:
        import re
        pattern = re.compile(title_pattern, re.IGNORECASE)
        all_windows = await self.list_windows()
        return [w for w in all_windows if pattern.search(w.title)]

    async def focus_window(self, window: WindowInfo) -> bool:
        if not self._available:
            return False
        try:
            if window.is_minimized:
                self.win32gui.ShowWindow(window.handle, self.win32con.SW_RESTORE)
            self.win32gui.SetForegroundWindow(window.handle)
            return True
        except Exception as e:
            logger.error(f"Failed to focus window: {e}")
            return False

    async def move_window(self, window: WindowInfo, x: int, y: int, width: int | None = None, height: int | None = None) -> bool:
        if not self._available:
            return False
        try:
            if width is None or height is None:
                w = window.rect[2] - window.rect[0]
                h = window.rect[3] - window.rect[1]
            else:
                w, h = width, height
            self.win32gui.MoveWindow(window.handle, x, y, w, h, True)
            return True
        except Exception as e:
            logger.error(f"Failed to move window: {e}")
            return False

    async def minimize_window(self, window: WindowInfo) -> bool:
        if not self._available:
            return False
        try:
            self.win32gui.ShowWindow(window.handle, self.win32con.SW_MINIMIZE)
            return True
        except Exception:
            return False

    async def maximize_window(self, window: WindowInfo) -> bool:
        if not self._available:
            return False
        try:
            self.win32gui.ShowWindow(window.handle, self.win32con.SW_MAXIMIZE)
            return True
        except Exception:
            return False

    async def close_window(self, window: WindowInfo) -> bool:
        if not self._available:
            return False
        try:
            self.win32gui.PostMessage(window.handle, self.win32con.WM_CLOSE, 0, 0)
            return True
        except Exception:
            return False

    async def snap_window(self, window: WindowInfo, position: str) -> bool:
        if not self._available:
            return False

        monitors = get_monitors()
        if not monitors:
            return False

        monitor = monitors[0]
        screen_w = monitor.width
        screen_h = monitor.height
        taskbar_h = 40  # Approximate

        positions = {
            "left": (0, 0, screen_w // 2, screen_h - taskbar_h),
            "right": (screen_w // 2, 0, screen_w // 2, screen_h - taskbar_h),
            "top": (0, 0, screen_w, screen_h // 2),
            "bottom": (0, screen_h // 2, screen_w, screen_h // 2),
            "topleft": (0, 0, screen_w // 2, screen_h // 2),
            "topright": (screen_w // 2, 0, screen_w // 2, screen_h // 2),
            "bottomleft": (0, screen_h // 2, screen_w // 2, screen_h // 2),
            "bottomright": (screen_w // 2, screen_h // 2, screen_w // 2, screen_h // 2),
            "full": (0, 0, screen_w, screen_h - taskbar_h),
        }

        pos = positions.get(position.lower())
        if not pos:
            return False

        return await self.move_window(window, pos[0], pos[1], pos[2], pos[3])


class LinuxWindowManager(WindowManager):
    """Linux window management using wmctrl/xdotool."""

    def __init__(self):
        self._wmctrl_available = self._check_command("wmctrl")
        self._xdotool_available = self._check_command("xdotool")

    def _check_command(self, cmd: str) -> bool:
        try:
            subprocess.run(["which", cmd], capture_output=True, check=True)
            return True
        except Exception:
            return False

    async def list_windows(self) -> list[WindowInfo]:
        if not self._wmctrl_available:
            return []

        try:
            result = subprocess.run(
                ["wmctrl", "-l", "-G", "-p"],
                capture_output=True, text=True, check=True
            )

            windows = []
            for line in result.stdout.strip().split("\n"):
                # Format: id desktop pid x y w h host title
                parts = line.split(None, 8)
                if len(parts) < 8:
                    continue

                handle = int(parts[0], 16)
                pid = int(parts[2])
                x, y, w, h = map(int, parts[3:7])
                title = parts[8] if len(parts) > 8 else ""

                try:
                    process = psutil.Process(pid)
                    process_name = process.name()
                except Exception:
                    process_name = "unknown"

                windows.append(WindowInfo(
                    title=title,
                    handle=handle,
                    rect=(x, y, x + w, y + h),
                    process_name=process_name,
                    process_id=pid,
                    is_visible=True,
                    is_minimized=False,
                    is_maximized=False,
                ))
            return windows
        except Exception as e:
            logger.error(f"Failed to list windows: {e}")
            return []

    async def find_window(self, title_pattern: str) -> list[WindowInfo]:
        import re
        pattern = re.compile(title_pattern, re.IGNORECASE)
        all_windows = await self.list_windows()
        return [w for w in all_windows if pattern.search(w.title)]

    async def focus_window(self, window: WindowInfo) -> bool:
        if not self._wmctrl_available:
            return False
        try:
            subprocess.run(["wmctrl", "-i", "-a", hex(window.handle)], check=True)
            return True
        except Exception:
            return False

    async def move_window(self, window: WindowInfo, x: int, y: int, width: int | None = None, height: int | None = None) -> bool:
        if not self._wmctrl_available:
            return False
        try:
            cmd = ["wmctrl", "-i", "-r", hex(window.handle), "-e", f"0,{x},{y},{width or -1},{height or -1}"]
            subprocess.run(cmd, check=True)
            return True
        except Exception:
            return False

    async def minimize_window(self, window: WindowInfo) -> bool:
        if not self._xdotool_available:
            return False
        try:
            subprocess.run(["xdotool", "windowminimize", str(window.handle)], check=True)
            return True
        except Exception:
            return False

    async def maximize_window(self, window: WindowInfo) -> bool:
        if not self._wmctrl_available:
            return False
        try:
            subprocess.run(["wmctrl", "-i", "-r", hex(window.handle), "-b", "add,maximized_vert,maximized_horz"], check=True)
            return True
        except Exception:
            return False

    async def close_window(self, window: WindowInfo) -> bool:
        if not self._wmctrl_available:
            return False
        try:
            subprocess.run(["wmctrl", "-i", "-c", hex(window.handle)], check=True)
            return True
        except Exception:
            return False

    async def snap_window(self, window: WindowInfo, position: str) -> bool:
        monitors = get_monitors()
        if not monitors:
            return False

        monitor = monitors[0]
        screen_w = monitor.width
        screen_h = monitor.height

        positions = {
            "left": (0, 0, screen_w // 2, screen_h),
            "right": (screen_w // 2, 0, screen_w // 2, screen_h),
            "top": (0, 0, screen_w, screen_h // 2),
            "bottom": (0, screen_h // 2, screen_w, screen_h // 2),
        }

        pos = positions.get(position.lower())
        if not pos:
            return False

        return await self.move_window(window, pos[0], pos[1], pos[2], pos[3])


class MacWindowManager(WindowManager):
    """macOS window management using AppleScript."""

    async def list_windows(self) -> list[WindowInfo]:
        # Implementation would use AppleScript via osascript
        return []

    async def find_window(self, title_pattern: str) -> list[WindowInfo]:
        return []

    async def focus_window(self, window: WindowInfo) -> bool:
        return False

    async def move_window(self, window: WindowInfo, x: int, y: int, width: int | None = None, height: int | None = None) -> bool:
        return False

    async def minimize_window(self, window: WindowInfo) -> bool:
        return False

    async def maximize_window(self, window: WindowInfo) -> bool:
        return False

    async def close_window(self, window: WindowInfo) -> bool:
        return False

    async def snap_window(self, window: WindowInfo, position: str) -> bool:
        return False


def get_window_manager() -> WindowManager:
    """Get platform-appropriate window manager."""
    import sys
    if sys.platform == "win32":
        return WindowsWindowManager()
    elif sys.platform == "linux":
        return LinuxWindowManager()
    elif sys.platform == "darwin":
        return MacWindowManager()
    else:
        return LinuxWindowManager()


class InputController:
    """Keyboard and mouse automation."""

    def __init__(self):
        self.keyboard_controller = keyboard.Controller()
        self.mouse_controller = mouse.Controller()

        # Key mapping for special keys
        self._special_keys = {
            "enter": keyboard.Key.enter,
            "tab": keyboard.Key.tab,
            "escape": keyboard.Key.esc,
            "space": keyboard.Key.space,
            "backspace": keyboard.Key.backspace,
            "delete": keyboard.Key.delete,
            "up": keyboard.Key.up,
            "down": keyboard.Key.down,
            "left": keyboard.Key.left,
            "right": keyboard.Key.right,
            "home": keyboard.Key.home,
            "end": keyboard.Key.end,
            "pageup": keyboard.Key.page_up,
            "pagedown": keyboard.Key.page_down,
            "f1": keyboard.Key.f1, "f2": keyboard.Key.f2, "f3": keyboard.Key.f3,
            "f4": keyboard.Key.f4, "f5": keyboard.Key.f5, "f6": keyboard.Key.f6,
            "f7": keyboard.Key.f7, "f8": keyboard.Key.f8, "f9": keyboard.Key.f9,
            "f10": keyboard.Key.f10, "f11": keyboard.Key.f11, "f12": keyboard.Key.f12,
            "ctrl": keyboard.Key.ctrl, "alt": keyboard.Key.alt,
            "shift": keyboard.Key.shift, "cmd": keyboard.Key.cmd,
            "win": keyboard.Key.cmd, "super": keyboard.Key.cmd,
        }

    def _parse_key(self, key_str: str) -> keyboard.Key | str:
        """Parse key string to pynput key."""
        key_lower = key_str.lower().strip()
        if key_lower in self._special_keys:
            return self._special_keys[key_lower]
        return key_str

    def _parse_keys(self, keys_str: str) -> list[keyboard.Key | str]:
        """Parse key combination string (e.g., 'ctrl+c', 'alt+tab')."""
        parts = keys_str.lower().split("+")
        return [self._parse_key(p.strip()) for p in parts]

    async def type_text(self, text: str, delay: float = 0.01) -> None:
        """Type text with optional delay between characters."""
        for char in text:
            self.keyboard_controller.type(char)
            if delay > 0:
                await asyncio.sleep(delay)

    async def press_keys(self, keys: str) -> None:
        """Press key combination (e.g., 'ctrl+c', 'alt+tab')."""
        parsed = self._parse_keys(keys)

        # Press all keys down
        for key in parsed:
            self.keyboard_controller.press(key)
            await asyncio.sleep(0.01)

        # Release in reverse order
        for key in reversed(parsed):
            self.keyboard_controller.release(key)
            await asyncio.sleep(0.01)

    async def click(self, x: int, y: int, button: str = "left", clicks: int = 1) -> None:
        """Click at screen coordinates."""
        pyautogui.click(x, y, clicks=clicks, button=button)

    async def double_click(self, x: int, y: int, button: str = "left") -> None:
        """Double click at coordinates."""
        await self.click(x, y, button, clicks=2)

    async def right_click(self, x: int, y: int) -> None:
        """Right click at coordinates."""
        await self.click(x, y, button="right")

    async def drag(self, from_x: int, from_y: int, to_x: int, to_y: int, duration: float = 0.5) -> None:
        """Drag from one point to another."""
        pyautogui.moveTo(from_x, from_y)
        pyautogui.dragTo(to_x, to_y, duration=duration, button="left")

    async def move_mouse(self, x: int, y: int, duration: float = 0.2) -> None:
        """Move mouse to coordinates."""
        pyautogui.moveTo(x, y, duration=duration)

    async def scroll(self, clicks: int, x: int | None = None, y: int | None = None) -> None:
        """Scroll mouse wheel."""
        if x is not None and y is not None:
            pyautogui.scroll(clicks, x=x, y=y)
        else:
            pyautogui.scroll(clicks)

    async def get_mouse_position(self) -> tuple[int, int]:
        """Get current mouse position."""
        return pyautogui.position()


class AppLauncher:
    """Application launching and management."""

    def __init__(self, settings: AgentSettings | None = None):
        self.settings = settings or get_settings().agent

    async def launch(self, app_name: str, args: list[str] | None = None) -> bool:
        """Launch application by name."""
        import sys

        # Common app mappings
        app_commands = {
            "vscode": ["code"],
            "code": ["code"],
            "chrome": ["chrome"],
            "firefox": ["firefox"],
            "edge": ["msedge"],
            "terminal": ["wt"] if sys.platform == "win32" else ["gnome-terminal"],
            "cmd": ["cmd"],
            "powershell": ["powershell"],
            "notepad": ["notepad"],
            "explorer": ["explorer"],
            "calc": ["calc"],
            "spotify": ["spotify"],
            "discord": ["discord"],
            "slack": ["slack"],
            "teams": ["teams"],
            "docker": ["docker"],
            "postman": ["postman"],
        }

        cmd = list(app_commands.get(app_name.lower(), [app_name]))
        if args:
            cmd.extend(args)

        try:
            # Use subprocess with detached process
            if sys.platform == "win32":
                subprocess.Popen(
                    cmd,
                    creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                    shell=True,
                )
            else:
                subprocess.Popen(cmd, start_new_session=True)
            logger.info(f"Launched: {' '.join(cmd)}")
            return True
        except Exception as e:
            logger.error(f"Failed to launch {app_name}: {e}")
            return False

    async def close(self, app_name: str) -> bool:
        """Close application by name."""
        closed_any = False
        try:
            for proc in psutil.process_iter(["name"]):
                try:
                    if app_name.lower() in (proc.info["name"] or "").lower():
                        proc.terminate()
                        closed_any = True
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue

            if closed_any:
                await asyncio.sleep(0.5)
                # Force-kill stragglers
                for proc in psutil.process_iter(["name"]):
                    try:
                        if app_name.lower() in (proc.info["name"] or "").lower():
                            proc.kill()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
            return closed_any
        except Exception as e:
            logger.error(f"Failed to close {app_name}: {e}")
            return False

    async def is_running(self, app_name: str) -> bool:
        """Check if app is running."""
        for proc in psutil.process_iter(["name"]):
            if app_name.lower() in proc.info["name"].lower():
                return True
        return False

    async def get_pid(self, app_name: str) -> list[int]:
        """Get PIDs of running app."""
        pids = []
        for proc in psutil.process_iter(["pid", "name"]):
            if app_name.lower() in proc.info["name"].lower():
                pids.append(proc.info["pid"])
        return pids

    async def activate(self, app_name: str) -> bool:
        """Bring an app's window to the foreground."""
        manager = get_window_manager()
        windows = await manager.find_window(app_name)
        if windows:
            return await manager.focus_window(windows[0])
        return False

    async def switch(self, app_name: str) -> bool:
        """Alias for activate."""
        return await self.activate(app_name)


class FileOperator:
    """Advanced file operations."""

    def __init__(self, settings: AgentSettings | None = None):
        self.settings = settings or get_settings().agent

    def _is_allowed_path(self, path: Path) -> bool:
        """Check if path is in allowed directories (blocked paths always win)."""
        try:
            resolved = path.expanduser().resolve()

            # Blocked paths take priority
            for blocked in self.settings.desktop_blocked_paths:
                blocked_path = Path(blocked).expanduser()
                try:
                    if resolved.is_relative_to(blocked_path.resolve()):
                        return False
                except OSError:
                    continue

            for allowed in self.settings.desktop_allowed_paths:
                allowed_path = Path(allowed).expanduser()
                try:
                    if resolved.is_relative_to(allowed_path.resolve()):
                        return True
                except OSError:
                    continue

            # Not explicitly allowed
            return not self.settings.desktop_safety_mode
        except Exception:
            return False

    async def list_files(self, path: str, pattern: str = "**/*") -> list[str]:
        """List files matching pattern."""
        base = Path(path).expanduser()
        if not self._is_allowed_path(base):
            raise PermissionError(f"Path not allowed: {path}")

        files = []
        for f in base.glob(pattern):
            if f.is_file():
                files.append(str(f.relative_to(base)))
        return files

    async def find_files(self, directory: str, name_pattern: str, content_pattern: str | None = None) -> list[str]:
        """Find files by name and optionally content."""
        base = Path(directory).expanduser()
        if not self._is_allowed_path(base):
            raise PermissionError(f"Directory not allowed: {directory}")

        import fnmatch
        results = []

        for file_path in base.rglob("*"):
            if file_path.is_file() and fnmatch.fnmatch(file_path.name, name_pattern):
                if content_pattern:
                    try:
                        content = file_path.read_text(encoding="utf-8", errors="ignore")
                        if content_pattern.lower() in content.lower():
                            results.append(str(file_path))
                    except Exception:
                        pass
                else:
                    results.append(str(file_path))

        return results

    async def read_file(self, path: str) -> str:
        """Read file content."""
        file_path = Path(path).expanduser()
        if not self._is_allowed_path(file_path):
            raise PermissionError(f"Path not allowed: {path}")
        return file_path.read_text(encoding="utf-8")

    async def write_file(self, path: str, content: str) -> None:
        """Write content to file."""
        file_path = Path(path).expanduser()
        if not self._is_allowed_path(file_path):
            raise PermissionError(f"Path not allowed: {path}")

        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")

    async def delete_file(self, path: str, confirm: bool = True) -> bool:
        """Delete file or directory."""
        file_path = Path(path).expanduser()
        if not self._is_allowed_path(file_path):
            raise PermissionError(f"Path not allowed: {path}")

        if confirm and self.settings.desktop_confirm_destructive:
            # In real usage, this would prompt user
            logger.warning(f"Delete requested for {path} (confirmation required)")

        try:
            if file_path.is_dir():
                import shutil
                shutil.rmtree(file_path)
            else:
                file_path.unlink()
            return True
        except Exception as e:
            logger.error(f"Failed to delete {path}: {e}")
            return False

    async def move_file(self, src: str, dst: str) -> bool:
        """Move file or directory."""
        src_path = Path(src).expanduser()
        dst_path = Path(dst).expanduser()

        if not self._is_allowed_path(src_path) or not self._is_allowed_path(dst_path):
            raise PermissionError("Source or destination not allowed")

        try:
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            src_path.rename(dst_path)
            return True
        except Exception as e:
            logger.error(f"Failed to move {src} to {dst}: {e}")
            return False

    async def copy_file(self, src: str, dst: str) -> bool:
        """Copy file or directory."""
        src_path = Path(src).expanduser()
        dst_path = Path(dst).expanduser()

        if not self._is_allowed_path(src_path) or not self._is_allowed_path(dst_path):
            raise PermissionError("Source or destination not allowed")

        try:
            import shutil
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            if src_path.is_dir():
                shutil.copytree(src_path, dst_path)
            else:
                shutil.copy2(src_path, dst_path)
            return True
        except Exception as e:
            logger.error(f"Failed to copy {src} to {dst}: {e}")
            return False

    async def organize_downloads(self) -> dict[str, int]:
        """Organize downloads folder by file type."""
        downloads = Path.home() / "Downloads"
        if not self._is_allowed_path(downloads):
            return {}

        categories = {
            "Images": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".ico"],
            "Documents": [".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".odt"],
            "Spreadsheets": [".xls", ".xlsx", ".csv", ".ods"],
            "Presentations": [".ppt", ".pptx", ".odp"],
            "Archives": [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"],
            "Code": [".py", ".js", ".ts", ".java", ".cpp", ".c", ".cs", ".go", ".rs", ".html", ".css"],
            "Media": [".mp4", ".avi", ".mkv", ".mov", ".mp3", ".wav", ".flac", ".m4a"],
            "Executables": [".exe", ".msi", ".dmg", ".pkg", ".deb", ".rpm", ".apk"],
        }

        moved = {cat: 0 for cat in categories}
        moved["Other"] = 0

        for file_path in downloads.iterdir():
            if not file_path.is_file():
                continue

            ext = file_path.suffix.lower()
            category = "Other"

            for cat, extensions in categories.items():
                if ext in extensions:
                    category = cat
                    break

            dest_dir = downloads / category
            dest_dir.mkdir(exist_ok=True)

            dest_file = dest_dir / file_path.name
            counter = 1
            while dest_file.exists():
                stem = file_path.stem
                dest_file = dest_dir / f"{stem}_{counter}{file_path.suffix}"
                counter += 1

            try:
                file_path.rename(dest_file)
                moved[category] += 1
            except Exception as e:
                logger.error(f"Failed to move {file_path}: {e}")

        return moved


class ScreenReader:
    """Screen capture and OCR."""

    def __init__(self):
        self._ocr_available = False
        try:
            import pytesseract
            self._pytesseract = pytesseract
            self._ocr_available = True
        except ImportError:
            pass

    async def capture_screen(self, region: ScreenRegion | None = None) -> Path:
        """Capture screen to image file."""
        output_dir = Path.home() / ".jaa" / "screenshots"
        output_dir.mkdir(parents=True, exist_ok=True)

        timestamp = int(time.time() * 1000)
        output_path = output_dir / f"screen_{timestamp}.png"

        if region:
            screenshot = await asyncio.to_thread(
                pyautogui.screenshot,
                region=(region.x, region.y, region.width, region.height),
            )
        else:
            screenshot = await asyncio.to_thread(pyautogui.screenshot)

        await asyncio.to_thread(screenshot.save, str(output_path))
        return output_path

    async def capture(self, region: ScreenRegion | None = None) -> Path:
        """Alias for capture_screen."""
        return await self.capture_screen(region)

    async def capture_window(self, window: WindowInfo) -> Path:
        """Capture specific window."""
        region = ScreenRegion(
            x=window.rect[0],
            y=window.rect[1],
            width=window.rect[2] - window.rect[0],
            height=window.rect[3] - window.rect[1],
        )
        return await self.capture_screen(region)

    async def ocr_image(self, image_path: Path) -> str:
        """Extract text from image using OCR."""
        if not self._ocr_available:
            raise RuntimeError("OCR not available. Install pytesseract and tesseract-ocr.")

        from PIL import Image
        image = Image.open(image_path)
        text = self._pytesseract.image_to_string(image)
        return text

    async def ocr_region(self, region: ScreenRegion) -> str:
        """Capture region and extract text."""
        image_path = await self.capture_screen(region)
        return await self.ocr_image(image_path)

    async def find_on_screen(self, template_path: Path, confidence: float = 0.8) -> list[tuple[int, int]]:
        """Find template image on screen."""
        try:
            import cv2
            import numpy as np

            screen_path = await self.capture_screen()
            screen = cv2.imread(str(screen_path), cv2.IMREAD_COLOR)
            template = cv2.imread(str(template_path), cv2.IMREAD_COLOR)

            result = cv2.matchTemplate(screen, template, cv2.TM_CCOEFF_NORMED)
            locations = np.where(result >= confidence)

            matches = []
            for pt in zip(*locations[::-1]):
                matches.append((pt[0], pt[1]))

            return matches
        except ImportError:
            raise RuntimeError("OpenCV not available. Install opencv-python.")


class DesktopAgent:
    """Main desktop automation agent."""

    def __init__(self, settings: AgentSettings | None = None):
        self.settings = settings or get_settings().agent
        self.window_manager = get_window_manager()
        self.input_controller = InputController()
        self.app_launcher = AppLauncher(self.settings)
        self.file_operator = FileOperator(self.settings)
        self.screen_reader = ScreenReader()
        self.action_history: list[DesktopAction] = []

        # Short aliases used by the orchestrator and MCP server
        self.apps = self.app_launcher
        self.windows = self.window_manager
        self.input = self.input_controller
        self.screen = self.screen_reader
        self.files = self.file_operator

    async def open_app(self, app_name: str) -> bool:
        """Launch application."""
        return await self.app_launcher.launch(app_name)

    async def close_app(self, app_name: str) -> bool:
        """Close application."""
        return await self.app_launcher.close(app_name)

    async def switch_to_app(self, app_name: str) -> bool:
        """Switch to application window."""
        windows = await self.window_manager.find_window(app_name)
        if windows:
            return await self.window_manager.focus_window(windows[0])
        return False

    async def arrange_windows(self, layout: str = "coding") -> bool:
        """Arrange windows in predefined layout."""
        windows = await self.window_manager.list_windows()

        if layout == "coding":
            # IDE on left, terminal on right, browser top-right
            code_windows = [w for w in windows if any(x in w.title.lower() for x in ["code", "vscode", "visual studio", "pycharm", "intellij"])]
            term_windows = [w for w in windows if any(x in w.title.lower() for x in ["terminal", "cmd", "powershell", "bash", "zsh"])]
            browser_windows = [w for w in windows if any(x in w.title.lower() for x in ["chrome", "firefox", "edge", "browser"])]

            if code_windows:
                await self.window_manager.snap_window(code_windows[0], "left")
            if term_windows:
                await self.window_manager.snap_window(term_windows[0], "right")
            if browser_windows:
                await self.window_manager.snap_window(browser_windows[0], "topright")

            return True

        elif layout == "side-by-side":
            visible = [w for w in windows if w.is_visible and not w.is_minimized]
            if len(visible) >= 2:
                await self.window_manager.snap_window(visible[0], "left")
                await self.window_manager.snap_window(visible[1], "right")
                return True

        return False

    async def type_text(self, text: str) -> None:
        """Type text at current cursor position."""
        await self.input_controller.type_text(text)

    async def press_shortcut(self, keys: str) -> None:
        """Press keyboard shortcut."""
        await self.input_controller.press_keys(keys)

    async def click_at(self, x: int, y: int) -> None:
        """Click at screen coordinates."""
        await self.input_controller.click(x, y)

    async def take_screenshot(self, region: ScreenRegion | None = None) -> Path:
        """Take screenshot."""
        return await self.screen_reader.capture_screen(region)

    async def read_screen_text(self, region: ScreenRegion | None = None) -> str:
        """Extract text from screen via OCR."""
        if region:
            return await self.screen_reader.ocr_region(region)
        else:
            image_path = await self.screen_reader.capture_screen()
            return await self.screen_reader.ocr_image(image_path)

    def _record_action(self, action_type: str, params: dict, result: Any = None, error: str | None = None) -> DesktopAction:
        action = DesktopAction(
            action_type=action_type,
            timestamp=time.time(),
            params=params,
            result=result,
            error=error,
        )
        self.action_history.append(action)
        return action


# Tool functions for LLM
async def desktop_open_app(app_name: str) -> dict:
    """Open application."""
    agent = DesktopAgent()
    success = await agent.open_app(app_name)
    return {"success": success, "app": app_name}


async def desktop_close_app(app_name: str) -> dict:
    """Close application."""
    agent = DesktopAgent()
    success = await agent.close_app(app_name)
    return {"success": success, "app": app_name}


async def desktop_focus_window(title_pattern: str) -> dict:
    """Focus window by title pattern."""
    agent = DesktopAgent()
    windows = await agent.window_manager.find_window(title_pattern)
    if windows:
        success = await agent.window_manager.focus_window(windows[0])
        return {"success": success, "window": windows[0].title}
    return {"success": False, "error": "No matching window found"}


async def desktop_arrange_windows(layout: str = "coding") -> dict:
    """Arrange windows in layout."""
    agent = DesktopAgent()
    success = await agent.arrange_windows(layout)
    return {"success": success, "layout": layout}


async def desktop_type_text(text: str) -> dict:
    """Type text."""
    agent = DesktopAgent()
    await agent.type_text(text)
    return {"success": True}


async def desktop_press_keys(keys: str) -> dict:
    """Press keyboard shortcut."""
    agent = DesktopAgent()
    await agent.press_shortcut(keys)
    return {"success": True, "keys": keys}


async def desktop_click(x: int, y: int) -> dict:
    """Click at coordinates."""
    agent = DesktopAgent()
    await agent.click_at(x, y)
    return {"success": True, "x": x, "y": y}


async def desktop_screenshot(region: dict | None = None) -> dict:
    """Take screenshot."""
    agent = DesktopAgent()
    screen_region = None
    if region:
        screen_region = ScreenRegion(**region)
    path = await agent.take_screenshot(screen_region)
    return {"success": True, "path": str(path)}


async def desktop_list_files(directory: str, pattern: str = "**/*") -> dict:
    """List files."""
    agent = DesktopAgent()
    try:
        files = await agent.file_operator.list_files(directory, pattern)
        return {"success": True, "files": files}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def desktop_find_files(directory: str, name_pattern: str, content_pattern: str | None = None) -> dict:
    """Find files."""
    agent = DesktopAgent()
    try:
        files = await agent.file_operator.find_files(directory, name_pattern, content_pattern)
        return {"success": True, "files": files}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def desktop_read_file(path: str) -> dict:
    """Read file."""
    agent = DesktopAgent()
    try:
        content = await agent.file_operator.read_file(path)
        return {"success": True, "content": content}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def desktop_write_file(path: str, content: str) -> dict:
    """Write file."""
    agent = DesktopAgent()
    try:
        await agent.file_operator.write_file(path, content)
        return {"success": True, "path": path}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def desktop_organize_downloads() -> dict:
    """Organize downloads folder."""
    agent = DesktopAgent()
    result = await agent.file_operator.organize_downloads()
    return {"success": True, "moved": result}


async def desktop_system_info() -> dict:
    """Get system information."""
    import os
    disk_path = os.path.splitdrive(str(Path.home()))[0] + "\\" if os.name == "nt" else "/"
    return {
        "cpu_percent": psutil.cpu_percent(interval=1),
        "memory": {
            "total": psutil.virtual_memory().total,
            "available": psutil.virtual_memory().available,
            "percent": psutil.virtual_memory().percent,
        },
        "disk": {
            "total": psutil.disk_usage(disk_path).total,
            "free": psutil.disk_usage(disk_path).free,
            "percent": psutil.disk_usage(disk_path).percent,
        },
        "processes": len(psutil.pids()),
    }