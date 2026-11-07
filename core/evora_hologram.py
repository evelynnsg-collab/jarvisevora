"""Animated HUD anchored to the hologram in Evora's supplied artwork."""
import math


def hologram_geometry(x, y, width, height):
    """Map artwork coordinates through the same aspect-preserving image fit."""
    return x + width * 0.685, y + height * 0.39, height * 0.235


def voice_level(level, speaking, muted):
    """Only assistant playback drives the voice bars; microphone input does not."""
    return max(0.0, min(1.0, float(level))) if speaking and not muted else 0.0


def paint_hologram(painter, x, y, width, height, phase, level, speaking, muted):
    from PyQt6.QtCore import Qt, QRectF, QLineF
    from PyQt6.QtGui import QColor, QPen, QFont, QRadialGradient, QBrush

    cx, cy, radius = hologram_geometry(x, y, width, height)
    amp = voice_level(level, speaking, muted)
    painter.save()
    try:
        # Shade the original static reactor/name so the live reactor reads clearly.
        painter.setPen(Qt.PenStyle.NoPen)
        shade = QRadialGradient(cx, cy, radius * 1.12)
        shade.setColorAt(0.0, QColor(0, 13, 27, 245))
        shade.setColorAt(0.76, QColor(0, 15, 32, 225))
        shade.setColorAt(1.0, QColor(0, 16, 30, 0))
        painter.setBrush(QBrush(shade))
        painter.drawEllipse(QRectF(cx-radius*1.12, cy-radius*1.12,
                                  radius*2.24, radius*2.24))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        color = QColor(50, 205, 255, 130 if muted else 230)
        for index, (fraction, direction, segments) in enumerate(
                ((1.0, 1, 9), (0.87, -1, 6), (0.73, 1, 4))):
            ring = radius * fraction * (1.0 + amp * 0.035)
            box = QRectF(cx-ring, cy-ring, ring*2, ring*2)
            painter.setPen(QPen(color, max(1.0, height * 0.004 + amp * 2)))
            angle = phase * (20 + index * 12) * direction
            for segment in range(segments):
                painter.drawArc(box, int((angle + segment*360/segments)*16),
                                int((360/segments-12)*16))
        # Audio-reactive radial spectrum, driven by the existing playback envelope.
        bars = []
        for index in range(64):
            angle = index * math.tau / 64
            pattern = 0.45 + 0.55 * (0.5 + 0.5*math.sin(index*1.7+phase*8))
            inner = radius * 0.56
            outer = inner + radius * (0.025 + amp * 0.26 * pattern)
            bars.append(QLineF(cx+math.cos(angle)*inner, cy+math.sin(angle)*inner,
                               cx+math.cos(angle)*outer, cy+math.sin(angle)*outer))
        painter.setPen(QPen(QColor(110, 235, 255), max(1.0, height*0.003)))
        painter.drawLines(bars)
        font = QFont('Courier New', max(8, int(radius*0.19)), QFont.Weight.Bold)
        painter.setFont(font)
        painter.setPen(QColor(190, 248, 255))
        painter.drawText(QRectF(cx-radius*0.52, cy-radius*0.18,
                               radius*1.04, radius*0.36),
                         Qt.AlignmentFlag.AlignCenter, 'EVORA')
    finally:
        painter.restore()
