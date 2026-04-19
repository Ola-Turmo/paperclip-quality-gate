from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs' / 'images'
OUT.mkdir(parents=True, exist_ok=True)

BG = '#040816'
SURFACE = '#18233b'
PANEL = '#0b1326'
BORDER = '#253553'
ACCENT = '#38bdf8'
TEXT = '#f8fafc'
MUTED = '#93a4bf'
GREEN = '#22c55e'
AMBER = '#f59e0b'
RED = '#ef4444'
PURPLE = '#8b5cf6'
WHITE = '#e5e7eb'
FONT_DIR = Path('/usr/share/fonts/truetype/dejavu')


def font(name: str, size: int):
    try:
        return ImageFont.truetype(str(FONT_DIR / name), size)
    except Exception:
        return ImageFont.load_default()


def rounded(draw: ImageDraw.ImageDraw, box, *, fill=SURFACE, outline=BORDER, width=2, radius=28):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def pill(draw: ImageDraw.ImageDraw, x: int, y: int, text: str, color: str) -> int:
    f = font('DejaVuSans.ttf', 26)
    bbox = draw.textbbox((0, 0), text, font=f)
    width = bbox[2] - bbox[0] + 36
    draw.rounded_rectangle((x, y, x + width, y + 50), radius=25, outline=color, width=2)
    draw.text((x + 18, y + 25), text, fill=color, font=f, anchor='lm')
    return width


def button(draw: ImageDraw.ImageDraw, x: int, y: int, text: str, color: str) -> int:
    f = font('DejaVuSans.ttf', 24)
    bbox = draw.textbbox((0, 0), text, font=f)
    width = bbox[2] - bbox[0] + 36
    draw.rounded_rectangle((x, y, x + width, y + 40), radius=20, fill=color)
    draw.text((x + width / 2, y + 20), text, fill=TEXT, font=f, anchor='mm')
    return width


def arrow(draw: ImageDraw.ImageDraw, x1: int, y: int, x2: int, color: str = MUTED):
    draw.line((x1, y, x2, y), fill=color, width=6)
    draw.polygon([(x2, y), (x2 - 18, y - 12), (x2 - 18, y + 12)], fill=color)


def make_banner() -> None:
    img = Image.new('RGB', (1600, 900), BG)
    d = ImageDraw.Draw(img)
    rounded(d, (40, 40, 1560, 860))
    d.text((80, 92), 'UOS QUALITY GATE', fill=ACCENT, font=font('DejaVuSans-Bold.ttf', 24))
    d.multiline_text((80, 150), 'Evidence-first human review\nfor autonomous delivery', fill=TEXT, font=font('DejaVuSans-Bold.ttf', 56), spacing=10)
    d.multiline_text((80, 320), 'Turn every Paperclip deliverable into a reviewer-ready package with\ntraceable evidence, risk flags, next-step guidance, and release controls.', fill=MUTED, font=font('DejaVuSans.ttf', 30), spacing=12)

    x = 80
    for label, color in [('Evidence bundle', ACCENT), ('Human approval', AMBER), ('Release controls', GREEN), ('Escalation lane', PURPLE)]:
        x += pill(d, x, 470, label, color) + 24

    cards = [('Decision score', '6/10'), ('Reviewer state', 'Needs review'), ('Evidence hash', 'qh_a1b2c3')]
    for idx, (k, v) in enumerate(cards):
        x = 80 + idx * 380
        rounded(d, (x, 610, x + 340, 770), fill=PANEL)
        d.text((x + 24, 652), k, fill=MUTED, font=font('DejaVuSans.ttf', 22))
        d.text((x + 24, 710), v, fill=TEXT, font=font('DejaVuSans-Bold.ttf', 34))

    img.save(OUT / 'quality-gate-banner.png')


def make_review_surface() -> None:
    img = Image.new('RGB', (1600, 900), BG)
    d = ImageDraw.Draw(img)
    rounded(d, (40, 40, 1560, 860))
    d.text((80, 92), 'REVIEW SURFACE', fill=ACCENT, font=font('DejaVuSans-Bold.ttf', 24))
    d.multiline_text((80, 145), 'One glance gives the operator the\ndraft, risks, and release choices', fill=TEXT, font=font('DejaVuSans-Bold.ttf', 50), spacing=10)

    rounded(d, (72, 330, 830, 780), fill=PANEL)
    d.text((104, 390), 'Draft artifact', fill=TEXT, font=font('DejaVuSans-Bold.ttf', 34))
    d.multiline_text((104, 462), 'Submitted output\nPrepared a reviewer-ready deliverable package with\nlinked context and explicit next-step guidance.\n\nEvaluation summary\nDecision score 6/10 → manual review lane.', fill=MUTED, font=font('DejaVuSans.ttf', 28), spacing=12)

    rounded(d, (870, 330, 1528, 560), fill=PANEL)
    d.text((902, 390), 'Risk flags', fill=TEXT, font=font('DejaVuSans-Bold.ttf', 34))
    pill(d, 902, 440, 'Manual hold requested', AMBER)
    pill(d, 902, 498, 'Compliance proof missing', RED)

    rounded(d, (870, 590, 1528, 720), fill=PANEL)
    d.text((902, 642), 'Evidence bundle', fill=TEXT, font=font('DejaVuSans-Bold.ttf', 34))
    d.multiline_text((902, 688), 'Issue: ISSUE-42\nEvidence hash: qh_a1b2c3', fill=MUTED, font=font('DejaVuSans.ttf', 24), spacing=10)

    rounded(d, (72, 798, 1450, 842), fill=PANEL, radius=18)
    x = 96
    for label, color in [('Approve', ACCENT), ('Approve & Release', GREEN), ('Request revision', RED), ('Return to agent', PURPLE), ('Escalate', AMBER)]:
        x += button(d, x, 800, label, color) + 16

    img.save(OUT / 'quality-gate-review-surface.png')


def make_flow() -> None:
    img = Image.new('RGB', (1600, 900), BG)
    d = ImageDraw.Draw(img)
    d.text((70, 90), 'REVIEW-TO-RELEASE FLOW', fill=ACCENT, font=font('DejaVuSans-Bold.ttf', 24))
    d.multiline_text((70, 140), 'Submit → Review → Hold / Revise / Escalate\n→ Release', fill=TEXT, font=font('DejaVuSans-Bold.ttf', 46), spacing=8)
    d.text((70, 260), 'Every decision leaves an evidence hash, a reviewer action, and a replayable audit trail on the issue.', fill=MUTED, font=font('DejaVuSans.ttf', 28))

    cards = [
        ('Submit\nevidence', 'Issue doc + summary', ACCENT),
        ('Assess risks', 'Decision score +\nchecks', AMBER),
        ('Choose\naction', 'Approve / revise /\nescalate', PURPLE),
        ('Release or\nreturn', 'Done / in progress', GREEN),
        ('Audit trail', 'Immutable evidence\nhash', WHITE),
    ]
    x, y, w, h, gap = 62, 470, 252, 148, 52
    for i, (title, sub, color) in enumerate(cards):
        rounded(d, (x, y, x + w, y + h), fill=SURFACE, outline=color, width=3, radius=26)
        d.multiline_text((x + 22, y + 36), title, fill=TEXT, font=font('DejaVuSans-Bold.ttf', 28), spacing=4)
        d.multiline_text((x + 22, y + 98), sub, fill=MUTED, font=font('DejaVuSans.ttf', 18), spacing=4)
        if i < len(cards) - 1:
            arrow(d, x + w + 10, y + h // 2, x + w + gap - 8)
        x += w + gap

    img.save(OUT / 'quality-gate-flow.png')


if __name__ == '__main__':
    make_banner()
    make_review_surface()
    make_flow()
    print(f'wrote refreshed marketing images to {OUT}')
