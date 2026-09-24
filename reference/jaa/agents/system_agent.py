"""
System Agent for J.A.A.

Provides system monitoring, process management, network tools,
and system settings control.
"""

from __future__ import annotations

import asyncio
import logging
import platform
import socket
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any

import psutil

from jaa.config.settings import AgentSettings, get_settings

logger = logging.getLogger(__name__)


@dataclass
class SystemInfo:
    """Comprehensive system information."""
    platform: str
    platform_version: str
    architecture: str
    hostname: str
    cpu_count: int
    cpu_freq: dict[str, float]
    memory_total: int
    memory_available: int
    disk_partitions: list[dict]
    network_interfaces: list[dict]
    boot_time: float
    uptime: float


@dataclass
class ProcessInfo:
    """Process information."""
    pid: int
    name: str
    exe: str | None
    cmdline: list[str]
    cpu_percent: float
    memory_percent: float
    memory_rss: int
    status: str
    create_time: float
    username: str
    num_threads: int


@dataclass
class NetworkConnection:
    """Network connection information."""
    fd: int
    family: int
    type: int
    local_address: str
    local_port: int
    remote_address: str | None
    remote_port: int | None
    status: str
    pid: int | None


class SystemMonitor:
    """System monitoring and metrics."""

    def __init__(self, settings: AgentSettings | None = None):
        self.settings = settings or get_settings().agent
        self._last_cpu_times = None
        self._last_check = 0

    async def get_system_info(self) -> SystemInfo:
        """Get comprehensive system information."""
        cpu_freq = psutil.cpu_freq()
        memory = psutil.virtual_memory()
        disk_partitions = []

        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                disk_partitions.append({
                    "device": part.device,
                    "mountpoint": part.mountpoint,
                    "fstype": part.fstype,
                    "total": usage.total,
                    "used": usage.used,
                    "free": usage.free,
                    "percent": usage.percent,
                })
            except Exception:
                pass

        network_interfaces = []
        for name, addrs in psutil.net_if_addrs().items():
            stats = psutil.net_if_stats().get(name)
            interface = {"name": name, "addresses": [], "is_up": stats.isup if stats else False}
            for addr in addrs:
                interface["addresses"].append({
                    "family": addr.family.name,
                    "address": addr.address,
                    "netmask": addr.netmask,
                    "broadcast": addr.broadcast,
                })
            network_interfaces.append(interface)

        boot_time = psutil.boot_time()
        uptime = time.time() - boot_time

        return SystemInfo(
            platform=platform.system(),
            platform_version=platform.version(),
            architecture=platform.machine(),
            hostname=socket.gethostname(),
            cpu_count=psutil.cpu_count(logical=True),
            cpu_freq={
                "current": cpu_freq.current if cpu_freq else 0,
                "min": cpu_freq.min if cpu_freq else 0,
                "max": cpu_freq.max if cpu_freq else 0,
            },
            memory_total=memory.total,
            memory_available=memory.available,
            disk_partitions=disk_partitions,
            network_interfaces=network_interfaces,
            boot_time=boot_time,
            uptime=uptime,
        )

    async def get_cpu_usage(self, interval: float = 1.0) -> dict[str, float]:
        """Get CPU usage per core and total."""
        percents = psutil.cpu_percent(interval=interval, percpu=True)
        return {
            "total": sum(percents) / len(percents) if percents else 0,
            "per_core": percents,
        }

    async def get_memory_usage(self) -> dict[str, int | float]:
        """Get memory usage."""
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        return {
            "total": mem.total,
            "available": mem.available,
            "used": mem.used,
            "free": mem.free,
            "percent": mem.percent,
            "swap_total": swap.total,
            "swap_used": swap.used,
            "swap_percent": swap.percent,
        }

    async def get_disk_usage(self, path: str | None = None) -> dict[str, int | float]:
        """Get disk usage for path (defaults to the home drive)."""
        if path is None:
            import os
            if os.name == "nt":
                from pathlib import Path
                path = os.path.splitdrive(str(Path.home()))[0] + "\\"
            else:
                path = "/"
        usage = psutil.disk_usage(path)
        return {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent": usage.percent,
        }

    async def get_network_io(self) -> dict[str, int]:
        """Get network I/O counters."""
        io = psutil.net_io_counters()
        return {
            "bytes_sent": io.bytes_sent,
            "bytes_recv": io.bytes_recv,
            "packets_sent": io.packets_sent,
            "packets_recv": io.packets_recv,
            "errin": io.errin,
            "errout": io.errout,
            "dropin": io.dropin,
            "dropout": io.dropout,
        }

    async def get_temperature(self) -> dict[str, float] | None:
        """Get system temperatures (if available)."""
        try:
            temps = psutil.sensors_temperatures()
            if not temps:
                return None
            result = {}
            for name, entries in temps.items():
                for entry in entries:
                    key = f"{name}_{entry.label or 'core'}"
                    result[key] = entry.current
            return result
        except Exception:
            return None

    async def get_battery(self) -> dict[str, Any] | None:
        """Get battery info (laptops)."""
        try:
            battery = psutil.sensors_battery()
            if not battery:
                return None
            return {
                "percent": battery.percent,
                "power_plugged": battery.power_plugged,
                "time_left": battery.secsleft if battery.secsleft != psutil.POWER_TIME_UNLIMITED else None,
            }
        except Exception:
            return None


class ProcessManager:
    """Process management."""

    def __init__(self, settings: AgentSettings | None = None):
        self.settings = settings or get_settings().agent

    async def list_processes(self, filter_name: str | None = None, limit: int = 50) -> list[ProcessInfo]:
        """List running processes."""
        processes = []

        for proc in psutil.process_iter([
            "pid", "name", "exe", "cmdline",
            "cpu_percent", "memory_percent", "memory_info",
            "status", "create_time", "username", "num_threads"
        ]):
            try:
                info = proc.info
                if filter_name and filter_name.lower() not in info["name"].lower():
                    continue

                processes.append(ProcessInfo(
                    pid=info["pid"],
                    name=info["name"],
                    exe=info["exe"],
                    cmdline=info["cmdline"] or [],
                    cpu_percent=info["cpu_percent"] or 0,
                    memory_percent=info["memory_percent"] or 0,
                    memory_rss=info["memory_info"].rss if info["memory_info"] else 0,
                    status=info["status"],
                    create_time=info["create_time"] or 0,
                    username=info["username"] or "unknown",
                    num_threads=info["num_threads"] or 0,
                ))
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue

        # Sort by CPU usage descending
        processes.sort(key=lambda p: p.cpu_percent, reverse=True)
        return processes[:limit]

    async def get_process(self, pid: int) -> ProcessInfo | None:
        """Get detailed process info."""
        try:
            proc = psutil.Process(pid)
            with proc.oneshot():
                return ProcessInfo(
                    pid=proc.pid,
                    name=proc.name(),
                    exe=proc.exe(),
                    cmdline=proc.cmdline(),
                    cpu_percent=proc.cpu_percent(),
                    memory_percent=proc.memory_percent(),
                    memory_rss=proc.memory_info().rss,
                    status=proc.status(),
                    create_time=proc.create_time(),
                    username=proc.username(),
                    num_threads=proc.num_threads(),
                )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return None

    async def kill_process(self, pid: int, force: bool = False) -> bool:
        """Kill process by PID."""
        try:
            proc = psutil.Process(pid)
            if force:
                proc.kill()
            else:
                proc.terminate()

            # Wait for termination
            for _ in range(10):
                if not proc.is_running():
                    return True
                await asyncio.sleep(0.5)

            # Force kill if still running
            if not force:
                proc.kill()
                await asyncio.sleep(0.5)
                return not proc.is_running()
            return False
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False

    async def set_priority(self, pid: int, priority: str) -> bool:
        """Set process priority."""
        try:
            proc = psutil.Process(pid)
            priority_map = {
                "realtime": psutil.REALTIME_PRIORITY_CLASS,
                "high": psutil.HIGH_PRIORITY_CLASS,
                "above_normal": psutil.ABOVE_NORMAL_PRIORITY_CLASS,
                "normal": psutil.NORMAL_PRIORITY_CLASS,
                "below_normal": psutil.BELOW_NORMAL_PRIORITY_CLASS,
                "idle": psutil.IDLE_PRIORITY_CLASS,
            }

            if priority.lower() not in priority_map:
                return False

            proc.nice(priority_map[priority.lower()])
            return True
        except (psutil.NoSuchProcess, psutil.AccessDenied, ValueError):
            return False

    async def get_process_children(self, pid: int) -> list[ProcessInfo]:
        """Get child processes."""
        try:
            proc = psutil.Process(pid)
            children = proc.children(recursive=True)
            return [
                ProcessInfo(
                    pid=c.pid,
                    name=c.name(),
                    exe=c.exe(),
                    cmdline=c.cmdline(),
                    cpu_percent=c.cpu_percent(),
                    memory_percent=c.memory_percent(),
                    memory_rss=c.memory_info().rss,
                    status=c.status(),
                    create_time=c.create_time(),
                    username=c.username(),
                    num_threads=c.num_threads(),
                )
                for c in children
            ]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return []


class NetworkTools:
    """Network diagnostic tools."""

    def __init__(self, settings: AgentSettings | None = None):
        self.settings = settings or get_settings().agent

    async def get_connections(self, kind: str = "inet") -> list[NetworkConnection]:
        """Get network connections."""
        connections = []

        for conn in psutil.net_connections(kind=kind):
            connections.append(NetworkConnection(
                fd=conn.fd,
                family=conn.family,
                type=conn.type,
                local_address=conn.laddr.ip if conn.laddr else "",
                local_port=conn.laddr.port if conn.laddr else 0,
                remote_address=conn.raddr.ip if conn.raddr else None,
                remote_port=conn.raddr.port if conn.raddr else None,
                status=conn.status,
                pid=conn.pid,
            ))

        return connections

    async def get_listening_ports(self) -> list[dict]:
        """Get listening ports with process info."""
        listening = []

        for conn in psutil.net_connections(kind="inet"):
            if conn.status == "LISTEN":
                proc_info = {}
                if conn.pid:
                    try:
                        proc = psutil.Process(conn.pid)
                        proc_info = {"pid": proc.pid, "name": proc.name()}
                    except Exception:
                        pass

                listening.append({
                    "local_address": conn.laddr.ip if conn.laddr else "",
                    "local_port": conn.laddr.port if conn.laddr else 0,
                    "protocol": "TCP" if conn.type == socket.SOCK_STREAM else "UDP",
                    "process": proc_info,
                })

        return listening

    async def ping(self, host: str, count: int = 4, timeout: float = 2.0) -> dict[str, Any]:
        """Ping a host."""
        import platform

        param = "-n" if platform.system().lower() == "windows" else "-c"
        cmd = ["ping", param, str(count), host]

        try:
            start = time.time()
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=count * timeout)
            elapsed = time.time() - start

            return {
                "host": host,
                "success": result.returncode == 0,
                "output": result.stdout,
                "error": result.stderr,
                "time_ms": elapsed * 1000,
            }
        except subprocess.TimeoutExpired:
            return {"host": host, "success": False, "error": "Timeout"}
        except Exception as e:
            return {"host": host, "success": False, "error": str(e)}

    async def traceroute(self, host: str, max_hops: int = 30) -> list[dict]:
        """Traceroute to host."""
        import platform

        cmd = ["tracert" if platform.system().lower() == "windows" else "traceroute", host]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            return {"host": host, "output": result.stdout, "success": result.returncode == 0}
        except Exception as e:
            return {"host": host, "success": False, "error": str(e)}

    async def port_scan(self, host: str, ports: list[int] | range = range(1, 1025)) -> list[int]:
        """Scan open ports on host."""
        open_ports = []

        async def check_port(port: int) -> int | None:
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(host, port),
                    timeout=1.0
                )
                writer.close()
                await writer.wait_closed()
                return port
            except Exception:
                return None

        # Scan in batches
        batch_size = 100
        for i in range(0, len(ports), batch_size):
            batch = list(ports)[i:i + batch_size]
            tasks = [check_port(p) for p in batch]
            results = await asyncio.gather(*tasks)
            open_ports.extend([r for r in results if r is not None])

        return sorted(open_ports)

    async def dns_lookup(self, hostname: str) -> dict[str, Any]:
        """DNS lookup."""
        try:
            ips = socket.gethostbyname_ex(hostname)
            return {
                "hostname": hostname,
                "addresses": ips[2],
                "aliases": ips[1],
                "success": True,
            }
        except socket.gaierror as e:
            return {"hostname": hostname, "success": False, "error": str(e)}


class SettingsManager:
    """System settings management (Windows-focused)."""

    def __init__(self, settings: AgentSettings | None = None):
        self.settings = settings or get_settings().agent

    async def get_env_var(self, name: str) -> str | None:
        """Get environment variable."""
        import os
        return os.environ.get(name)

    async def set_env_var(self, name: str, value: str, permanent: bool = False) -> bool:
        """Set environment variable."""
        import os

        if permanent:
            # Windows: setx or registry
            import sys
            if sys.platform == "win32":
                try:
                    subprocess.run(["setx", name, value], check=True)
                    return True
                except Exception:
                    return False
        else:
            os.environ[name] = value
            return True

    async def get_service_status(self, service_name: str) -> dict[str, Any]:
        """Get Windows service status."""
        import sys
        if sys.platform != "win32":
            return {"error": "Windows only"}

        try:
            result = subprocess.run(
                ["sc", "query", service_name],
                capture_output=True, text=True
            )
            return {"service": service_name, "output": result.stdout, "success": result.returncode == 0}
        except Exception as e:
            return {"service": service_name, "success": False, "error": str(e)}

    async def start_service(self, service_name: str) -> bool:
        """Start Windows service."""
        import sys
        if sys.platform != "win32":
            return False

        try:
            subprocess.run(["sc", "start", service_name], check=True)
            return True
        except Exception:
            return False

    async def stop_service(self, service_name: str) -> bool:
        """Stop Windows service."""
        import sys
        if sys.platform != "win32":
            return False

        try:
            subprocess.run(["sc", "stop", service_name], check=True)
            return True
        except Exception:
            return False


class SystemAgent:
    """Main system agent."""

    def __init__(self, settings: AgentSettings | None = None):
        self.settings = settings or get_settings().agent
        self.monitor = SystemMonitor(self.settings)
        self.processes = ProcessManager(self.settings)
        self.network = NetworkTools(self.settings)
        self.settings_mgr = SettingsManager(self.settings)

    async def get_system_status(self) -> dict:
        """Get overall system status."""
        info = await self.monitor.get_system_info()
        cpu = await self.monitor.get_cpu_usage()
        memory = await self.monitor.get_memory_usage()
        disk = await self.monitor.get_disk_usage()

        return {
            "system": {
                "platform": info.platform,
                "hostname": info.hostname,
                "uptime_seconds": info.uptime,
            },
            "cpu": cpu,
            "memory": memory,
            "disk": disk,
        }

    async def list_top_processes(self, limit: int = 10) -> list[dict]:
        """List top processes by CPU."""
        processes = await self.processes.list_processes(limit=limit)
        return [
            {
                "pid": p.pid,
                "name": p.name,
                "cpu_percent": p.cpu_percent,
                "memory_percent": p.memory_percent,
                "memory_mb": p.memory_rss / 1024 / 1024,
                "status": p.status,
            }
            for p in processes
        ]

    async def check_port(self, port: int) -> dict:
        """Check if port is in use."""
        connections = await self.network.get_connections()
        for conn in connections:
            if conn.local_port == port and conn.status == "LISTEN":
                proc_info = {}
                if conn.pid:
                    try:
                        proc = psutil.Process(conn.pid)
                        proc_info = {"pid": proc.pid, "name": proc.name()}
                    except Exception:
                        pass
                return {"port": port, "in_use": True, "process": proc_info}
        return {"port": port, "in_use": False}

    async def free_port(self, port: int) -> bool:
        """Kill process using port."""
        connections = await self.network.get_connections()
        for conn in connections:
            if conn.local_port == port and conn.pid:
                return await self.processes.kill_process(conn.pid)
        return False