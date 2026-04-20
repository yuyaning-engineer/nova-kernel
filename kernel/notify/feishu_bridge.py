# -*- coding: utf-8 -*-
"""Minimal Feishu bridge stub for commerce-edition."""

from __future__ import annotations

import argparse
import os
import sys


MESSAGE = (
    "Feishu bridge: external redops dependency removed; "
    "configure FEISHU_WEBHOOK_URL in .env to enable"
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Nova Kernel Feishu bridge stub")
    parser.add_argument("--test", action="store_true", help="Log stub status and exit")
    parser.add_argument("--start", action="store_true", help="Log stub status and exit")
    parser.parse_args()

    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass

    webhook = os.environ.get("FEISHU_WEBHOOK_URL", "").strip()
    if webhook:
        print(f"{MESSAGE} (webhook present but bridge disabled)")
    else:
        print(MESSAGE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
