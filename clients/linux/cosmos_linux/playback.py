"""Speech playback with QtMultimedia. Only playback that reaches the end of the
delivered bytes counts as complete; stopping never reports completion."""
from __future__ import annotations

import logging
from typing import Callable, Optional

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QUrl

from .events import SpeechReply

log = logging.getLogger("cosmos.playback")


class QtSpeechPlayer(QObject):
    def __init__(self, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self._player = None
        self._output = None
        self._buffer: Optional[QBuffer] = None
        self._reply: Optional[SpeechReply] = None
        self._on_finished: Optional[Callable[[bool], None]] = None

    def play(self, reply: SpeechReply, audio: bytes, on_finished: Callable[[bool], None]) -> bool:
        self.stop()
        try:
            from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
        except ImportError:
            log.warning("QtMultimedia is unavailable; the spoken reply is shown as text only")
            return False
        try:
            buffer = QBuffer(self)
            buffer.setData(QByteArray(audio))
            if not buffer.open(QIODevice.OpenModeFlag.ReadOnly):
                return False
            player = QMediaPlayer(self)
            output = QAudioOutput(self)
            player.setAudioOutput(output)
            player.mediaStatusChanged.connect(self._status_changed)
            player.errorOccurred.connect(self._error_occurred)
            player.setSourceDevice(buffer, QUrl("cosmos-reply.mp3"))
            player.play()
        except Exception:
            log.exception("speech playback could not start")
            return False
        self._buffer = buffer
        self._player = player
        self._output = output
        self._reply = reply
        self._on_finished = on_finished
        return True

    def _finish(self, completed: bool) -> None:
        callback, self._on_finished = self._on_finished, None
        self._release()
        if callback is not None:
            callback(completed)

    def _status_changed(self, status) -> None:
        from PySide6.QtMultimedia import QMediaPlayer
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self._finish(True)
        elif status == QMediaPlayer.MediaStatus.InvalidMedia:
            self._finish(False)

    def _error_occurred(self, *_arguments) -> None:
        if self._on_finished is not None:
            self._finish(False)

    def _release(self) -> None:
        player, self._player = self._player, None
        if player is not None:
            try:
                player.mediaStatusChanged.disconnect(self._status_changed)
                player.errorOccurred.disconnect(self._error_occurred)
            except (RuntimeError, TypeError):
                pass
            player.stop()
            player.setSourceDevice(None)
            player.deleteLater()
        output, self._output = self._output, None
        if output is not None:
            output.deleteLater()
        buffer, self._buffer = self._buffer, None
        if buffer is not None:
            buffer.close()
            buffer.deleteLater()
        self._reply = None

    def stop(self) -> None:
        self._on_finished = None
        self._release()
