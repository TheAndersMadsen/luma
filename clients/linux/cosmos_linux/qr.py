"""The approval link as a QR code, rendered locally with segno. The link carries
only the public descriptor; nothing is sent anywhere to draw it."""
from __future__ import annotations

import base64
import io


def approval_qr_png(link: str, scale: int = 5) -> bytes:
    import segno

    code = segno.make(link, error="m")
    output = io.BytesIO()
    code.save(output, kind="png", scale=scale, border=2, dark="#030809", light="#ffffff")
    return output.getvalue()


def approval_qr_data_url(link: str) -> str:
    """A ``data:`` URL for a QML Image, or an empty string when segno is unavailable."""
    try:
        png = approval_qr_png(link)
    except Exception:
        return ""
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")
