"""
Voice pipeline components for J.A.A.

Provides speech-to-text, text-to-speech, wake word detection,
and audio I/O with voice activity detection.
"""

from __future__ import annotations

import asyncio
import logging
import wave
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncGenerator, Optional

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

from jaa.config.settings import VoiceSettings, get_settings

logger = logging.getLogger(__name__)


@dataclass
class AudioChunk:
    """Represents a chunk of audio data."""
    data: np.ndarray
    sample_rate: int
    timestamp: float
    is_speech: bool = False


@dataclass
class TranscriptionResult:
    """Result of speech-to-text transcription."""
    text: str
    language: str
    language_probability: float
    duration: float
    segments: list[dict]
    is_final: bool = True


class STTEngine(ABC):
    """Abstract base class for speech-to-text engines."""

    @abstractmethod
    async def transcribe(self, audio: np.ndarray, sample_rate: int) -> TranscriptionResult:
        """Transcribe audio to text."""
        pass

    @abstractmethod
    async def transcribe_stream(
        self,
        audio_stream: AsyncGenerator[AudioChunk, None]
    ) -> AsyncGenerator[TranscriptionResult, None]:
        """Stream transcription from audio chunks."""
        pass

    @abstractmethod
    async def warmup(self) -> None:
        """Warm up the model."""
        pass


class FasterWhisperSTT(STTEngine):
    """Faster-Whisper based STT engine (CTranslate2 backend)."""

    def __init__(self, settings: VoiceSettings | None = None):
        self.settings = settings or get_settings().voice
        self._model: WhisperModel | None = None
        self._model_lock = asyncio.Lock()

    async def _get_model(self) -> WhisperModel:
        """Lazy load the Whisper model."""
        async with self._model_lock:
            if self._model is None:
                logger.info(f"Loading Whisper model: {self.settings.stt_model}")
                device = self.settings.stt_device
                compute_type = self.settings.stt_compute_type
                try:
                    self._model = WhisperModel(
                        self.settings.stt_model,
                        device=device,
                        compute_type=compute_type,
                        download_root=str(Path.home() / ".cache" / "whisper"),
                    )
                except (ValueError, RuntimeError):
                    # float16 is unsupported on CPU - fall back to int8
                    logger.warning("Falling back to CPU/int8 for Whisper model")
                    self._model = WhisperModel(
                        self.settings.stt_model,
                        device="cpu",
                        compute_type="int8",
                        download_root=str(Path.home() / ".cache" / "whisper"),
                    )
                logger.info("Whisper model loaded successfully")
            return self._model

    async def warmup(self) -> None:
        """Warm up the model with a dummy transcription."""
        model = await self._get_model()
        # Run a quick dummy transcription
        dummy_audio = np.zeros(16000, dtype=np.float32)
        await asyncio.to_thread(
            lambda: list(model.transcribe(dummy_audio, language="en"))
        )
        logger.debug("STT engine warmed up")

    async def transcribe(self, audio: np.ndarray, sample_rate: int) -> TranscriptionResult:
        """Transcribe audio to text."""
        model = await self._get_model()

        # Resample if needed
        if sample_rate != 16000:
            audio = await self._resample(audio, sample_rate, 16000)

        # Ensure float32
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        # Transcribe
        segments, info = await asyncio.to_thread(
            model.transcribe,
            audio,
            language="en" if self.settings.stt_language == "en" else None,
            vad_filter=self.settings.stt_vad_filter,
            beam_size=5,
            word_timestamps=True,
        )

        # Collect segments
        segment_list = []
        full_text = []
        for segment in segments:
            segment_list.append({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "words": [
                    {"word": w.word, "start": w.start, "end": w.end, "probability": w.probability}
                    for w in (segment.words or [])
                ] if segment.words else [],
            })
            full_text.append(segment.text)

        return TranscriptionResult(
            text=" ".join(full_text).strip(),
            language=info.language,
            language_probability=info.language_probability,
            duration=info.duration,
            segments=segment_list,
            is_final=True,
        )

    async def transcribe_stream(
        self,
        audio_stream: AsyncGenerator[AudioChunk, None]
    ) -> AsyncGenerator[TranscriptionResult, None]:
        """Stream transcription from audio chunks."""
        model = await self._get_model()

        buffer = np.array([], dtype=np.float32)
        buffer_duration = 0.0
        chunk_duration = 0.0

        async for chunk in audio_stream:
            if chunk.data.dtype != np.float32:
                chunk_data = chunk.data.astype(np.float32)
            else:
                chunk_data = chunk.data

            # Resample if needed
            if chunk.sample_rate != 16000:
                chunk_data = await self._resample(chunk_data, chunk.sample_rate, 16000)

            buffer = np.concatenate([buffer, chunk_data])
            buffer_duration += len(chunk_data) / 16000

            # Process when we have enough audio (e.g., 2 seconds)
            if buffer_duration >= 2.0 or chunk.is_speech:
                # Transcribe buffer
                segments, info = await asyncio.to_thread(
                    model.transcribe,
                    buffer,
                    language="en" if self.settings.stt_language == "en" else None,
                    vad_filter=self.settings.stt_vad_filter,
                )

                segment_list = []
                full_text = []
                for segment in segments:
                    segment_list.append({
                        "start": segment.start,
                        "end": segment.end,
                        "text": segment.text,
                    })
                    full_text.append(segment.text)

                yield TranscriptionResult(
                    text=" ".join(full_text).strip(),
                    language=info.language,
                    language_probability=info.language_probability,
                    duration=buffer_duration,
                    segments=segment_list,
                    is_final=False,
                )

                # Keep last 0.5 seconds for context
                keep_samples = int(0.5 * 16000)
                if len(buffer) > keep_samples:
                    buffer = buffer[-keep_samples:]
                    buffer_duration = len(buffer) / 16000

    async def _resample(self, audio: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
        """Resample audio using scipy if available, otherwise simple linear interpolation."""
        if from_rate == to_rate:
            return audio

        try:
            from scipy.signal import resample
            num_samples = int(len(audio) * to_rate / from_rate)
            return resample(audio, num_samples)
        except ImportError:
            # Simple linear interpolation fallback
            ratio = from_rate / to_rate
            new_length = int(len(audio) / ratio)
            indices = np.linspace(0, len(audio) - 1, new_length)
            return np.interp(indices, np.arange(len(audio)), audio).astype(np.float32)


class TTSEngine(ABC):
    """Abstract base class for text-to-speech engines."""

    @abstractmethod
    async def synthesize(self, text: str, output_path: Path | None = None) -> Path:
        """Synthesize text to speech audio file."""
        pass

    @abstractmethod
    async def synthesize_stream(self, text: str) -> AsyncGenerator[np.ndarray, None]:
        """Stream synthesized audio chunks."""
        pass

    @abstractmethod
    async def warmup(self) -> None:
        """Warm up the TTS engine."""
        pass


class PiperTTS(TTSEngine):
    """Piper TTS engine - fast, offline, natural voices."""

    def __init__(self, settings: VoiceSettings | None = None):
        self.settings = settings or get_settings().voice
        self._voice_path: Path | None = None
        self._synthesize_fn = None

    async def _ensure_voice(self) -> Path:
        """Download and cache Piper voice if needed."""
        if self._voice_path and self._voice_path.exists():
            return self._voice_path

        voice_name = self.settings.tts_voice
        cache_dir = Path.home() / ".cache" / "piper" / "voices"
        cache_dir.mkdir(parents=True, exist_ok=True)

        voice_path = cache_dir / f"{voice_name}.onnx"
        config_path = cache_dir / f"{voice_name}.onnx.json"

        if not voice_path.exists():
            logger.info(f"Downloading Piper voice: {voice_name}")
            # In production, use piper.download_voice()
            # For now, expect voices to be pre-downloaded
            raise FileNotFoundError(
                f"Piper voice not found: {voice_path}. "
                f"Run: piper --download-voice {voice_name}"
            )

        self._voice_path = voice_path
        return voice_path

    async def warmup(self) -> None:
        """Warm up Piper TTS."""
        await self._ensure_voice()
        # Piper doesn't need explicit warmup
        logger.debug("Piper TTS warmed up")

    async def synthesize(self, text: str, output_path: Path | None = None) -> Path:
        """Synthesize text to speech using Piper."""
        import subprocess

        voice_path = await self._ensure_voice()

        if output_path is None:
            import hashlib
            digest = hashlib.sha256(text.encode()).hexdigest()[:16]
            output_path = Path.home() / ".jaa" / "voice" / f"tts_{digest}.wav"
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Use piper CLI for synthesis (length_scale is the inverse of speed)
        length_scale = 1.0 / self.settings.tts_speed if self.settings.tts_speed > 0 else 1.0
        cmd = [
            "piper",
            "--model", str(voice_path),
            "--output_file", str(output_path),
            "--length_scale", str(length_scale),
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate(input=text.encode())

            if proc.returncode != 0:
                raise RuntimeError(f"Piper TTS failed: {stderr.decode()}")

            logger.debug(f"TTS synthesized to {output_path}")
            return output_path

        except FileNotFoundError:
            raise RuntimeError("Piper not installed. Install with: pip install piper-tts")

    async def synthesize_stream(self, text: str) -> AsyncGenerator[np.ndarray, None]:
        """Stream synthesized audio chunks."""
        # For streaming, we'd use Piper's streaming API
        # For now, synthesize to file and yield chunks
        output_path = await self.synthesize(text)

        # Read and yield in chunks
        with wave.open(str(output_path), "rb") as wf:
            chunk_size = 1024
            while True:
                frames = wf.readframes(chunk_size)
                if not frames:
                    break
                audio_data = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                yield audio_data


class WakeWordEngine(ABC):
    """Abstract base class for wake word detection."""

    @abstractmethod
    async def detect(self, audio: np.ndarray) -> tuple[bool, float]:
        """Detect wake word in audio. Returns (detected, confidence)."""
        pass

    @abstractmethod
    async def warmup(self) -> None:
        """Warm up the wake word engine."""
        pass


class PorcupineWakeWord(WakeWordEngine):
    """Picovoice Porcupine wake word engine."""

    def __init__(self, settings: VoiceSettings | None = None):
        self.settings = settings or get_settings().voice
        self._porcupine = None
        self._keywords = [self.settings.wake_word]

    async def warmup(self) -> None:
        """Initialize Porcupine."""
        try:
            import pvporcupine
        except ImportError:
            logger.warning("Porcupine not installed. Wake word detection disabled. Install with: pip install pvporcupine")
            return

        # Get access key from environment
        import os
        access_key_value = os.getenv("PICOVOICE_ACCESS_KEY")

        if not access_key_value:
            logger.warning("PICOVOICE_ACCESS_KEY not set. Wake word detection disabled.")
            return

        try:
            self._porcupine = pvporcupine.create(
                access_key=access_key_value,
                keywords=["jarvis"],  # Built-in keyword closest to "hey jaa"
                sensitivities=[self.settings.wake_word_sensitivity],
            )
            logger.info(f"Porcupine initialized (wake word: {self.settings.wake_word})")
        except Exception as e:
            logger.warning(f"Failed to initialize Porcupine: {e}. Wake word detection disabled.")
            self._porcupine = None

    async def detect(self, audio: np.ndarray) -> tuple[bool, float]:
        """Detect wake word in audio frame."""
        if self._porcupine is None:
            return False, 0.0

        # Porcupine expects 16-bit PCM at 16kHz
        if audio.dtype != np.int16:
            audio = (audio * 32767).astype(np.int16)

        # Process frame (512 samples for 16kHz)
        frame_length = self._porcupine.frame_length
        if len(audio) < frame_length:
            return False, 0.0

        keyword_index = self._porcupine.process(audio[:frame_length])
        detected = keyword_index >= 0
        confidence = 1.0 if detected else 0.0

        return detected, confidence


class AudioIO:
    """Cross-platform audio input/output."""

    def __init__(self, settings: VoiceSettings | None = None):
        self.settings = settings or get_settings().voice
        self._input_stream: sd.InputStream | None = None
        self._output_stream: sd.OutputStream | None = None
        self._sample_rate = self.settings.sample_rate
        self._channels = self.settings.channels
        self._block_size = self.settings.chunk_size

    async def start_input(self, callback) -> None:
        """Start audio input stream."""
        self._input_stream = sd.InputStream(
            samplerate=self._sample_rate,
            channels=self._channels,
            blocksize=self._block_size,
            dtype=np.float32,
            callback=callback,
        )
        self._input_stream.start()
        logger.debug("Audio input started")

    async def stop_input(self) -> None:
        """Stop audio input stream."""
        if self._input_stream:
            self._input_stream.stop()
            self._input_stream.close()
            self._input_stream = None
            logger.debug("Audio input stopped")

    async def play_audio(self, audio: np.ndarray, sample_rate: int | None = None) -> None:
        """Play audio through output device."""
        if sample_rate is None:
            sample_rate = self._sample_rate

        # Resample if needed
        if sample_rate != self._sample_rate:
            from scipy.signal import resample
            num_samples = int(len(audio) * self._sample_rate / sample_rate)
            audio = resample(audio, num_samples)

        # Ensure float32 in range [-1, 1]
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)
        audio = np.clip(audio, -1.0, 1.0)

        # Play
        await asyncio.to_thread(sd.play, audio, self._sample_rate)
        await asyncio.to_thread(sd.wait)

    async def play_file(self, path: Path) -> None:
        """Play audio file."""
        import soundfile as sf
        audio, sample_rate = await asyncio.to_thread(sf.read, str(path))
        await self.play_audio(audio, sample_rate)


class VoiceActivityDetector:
    """Voice Activity Detection using Silero VAD."""

    def __init__(self, settings: VoiceSettings | None = None):
        self.settings = settings or get_settings().voice
        self._model = None
        self._threshold = self.settings.stt_vad_threshold

    async def _load_model(self):
        """Load Silero VAD model."""
        if self._model is None:
            import torch
            self._model, utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                force_reload=False,
                trust_repo=True,
            )
            self._get_speech_timestamps = utils[0]
            logger.debug("Silero VAD model loaded")

    async def is_speech(self, audio: np.ndarray, sample_rate: int = 16000) -> bool:
        """Check if audio contains speech."""
        await self._load_model()

        # Ensure correct format
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)

        if sample_rate != 16000:
            from scipy.signal import resample
            num_samples = int(len(audio) * 16000 / sample_rate)
            audio = resample(audio, num_samples)

        # Get speech probability
        import torch
        with torch.no_grad():
            speech_prob = self._model(torch.from_numpy(audio), 16000).item()

        return speech_prob > self._threshold

    async def get_speech_segments(self, audio: np.ndarray, sample_rate: int = 16000) -> list[tuple[float, float]]:
        """Get speech segment timestamps."""
        await self._load_model()

        if sample_rate != 16000:
            from scipy.signal import resample
            num_samples = int(len(audio) * 16000 / sample_rate)
            audio = resample(audio, num_samples)

        import torch
        with torch.no_grad():
            timestamps = self._get_speech_timestamps(
                torch.from_numpy(audio.astype(np.float32)),
                self._model,
                sampling_rate=16000,
            )

        return [(ts["start"] / 16000, ts["end"] / 16000) for ts in timestamps]


class VoicePipeline:
    """Complete voice processing pipeline."""

    def __init__(self, settings: VoiceSettings | None = None):
        self.settings = settings or get_settings().voice
        self.stt = FasterWhisperSTT(self.settings)
        self.tts = PiperTTS(self.settings)
        self.wake_word = PorcupineWakeWord(self.settings)
        self.audio = AudioIO(self.settings)
        self.vad = VoiceActivityDetector(self.settings)

        self._listening = False
        self._wake_word_detected = asyncio.Event()
        self._audio_queue: asyncio.Queue[AudioChunk] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None

    async def initialize(self) -> None:
        """Initialize all voice components."""
        logger.info("Initializing voice pipeline...")
        results = await asyncio.gather(
            self.stt.warmup(),
            self.tts.warmup(),
            self.wake_word.warmup(),
            return_exceptions=True,
        )
        for name, result in zip(("STT", "TTS", "wake word"), results):
            if isinstance(result, Exception):
                logger.warning(f"Voice component {name} failed to warm up: {result}")
        logger.info("Voice pipeline initialized")

    async def start_listening(self) -> AsyncGenerator[TranscriptionResult, None]:
        """Start listening for speech after wake word."""
        self._listening = True
        self._wake_word_detected.clear()
        self._loop = asyncio.get_running_loop()

        # If no wake word engine is available, skip straight to transcription
        if self.wake_word._porcupine is None:
            self._wake_word_detected.set()

        # Audio callback - runs on sounddevice's thread, so hand off to
        # the event loop thread-safely instead of touching asyncio directly.
        def audio_callback(indata, frames, time_info, status):
            if status:
                logger.warning(f"Audio callback status: {status}")

            chunk = AudioChunk(
                data=indata.copy().flatten(),
                sample_rate=self.settings.sample_rate,
                timestamp=time_info.inputBufferAdcTime,
            )

            if self._loop is not None and not self._loop.is_closed():
                self._loop.call_soon_threadsafe(self._handle_chunk, chunk)

        await self.audio.start_input(audio_callback)

        try:
            # Wait for wake word
            await self._wake_word_detected.wait()
            logger.info("Wake word detected!")

            # Play acknowledgment
            try:
                await self.speak("Yes?")
            except Exception as e:
                logger.debug(f"Could not play acknowledgment: {e}")

            # Start streaming STT
            async for result in self.stt.transcribe_stream(self._audio_stream()):
                yield result

        finally:
            self._listening = False
            await self.audio.stop_input()

    def _handle_chunk(self, chunk: AudioChunk) -> None:
        """Route an audio chunk (runs on the event loop thread)."""
        if not self._listening:
            return
        if not self._wake_word_detected.is_set():
            asyncio.ensure_future(self._check_wake_word(chunk))
        else:
            self._audio_queue.put_nowait(chunk)

    async def _audio_stream(self) -> AsyncGenerator[AudioChunk, None]:
        """Yield audio chunks from the queue."""
        while self._listening:
            try:
                chunk = await asyncio.wait_for(self._audio_queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            yield chunk

    async def _check_wake_word(self, chunk: AudioChunk) -> None:
        """Check audio chunk for wake word."""
        detected, confidence = await self.wake_word.detect(chunk.data)
        if detected:
            logger.info(f"Wake word detected (confidence: {confidence})")
            self._wake_word_detected.set()

    async def speak(self, text: str) -> None:
        """Speak text using TTS."""
        logger.debug(f"Speaking: {text[:50]}...")
        output_path = await self.tts.synthesize(text)
        await self.audio.play_file(output_path)

    async def transcribe_file(self, path: Path) -> TranscriptionResult:
        """Transcribe audio file."""
        import soundfile as sf
        audio, sample_rate = await asyncio.to_thread(sf.read, str(path))
        return await self.stt.transcribe(audio, sample_rate)

    async def shutdown(self) -> None:
        """Shutdown voice pipeline."""
        self._listening = False
        await self.audio.stop_input()
        logger.info("Voice pipeline shutdown")