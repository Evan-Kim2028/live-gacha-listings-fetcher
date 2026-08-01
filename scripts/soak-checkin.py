#!/usr/bin/env python3
"""30-minute soak check-in for live-resume robustness goal.

Writes goal/scratch/checkins/NN.json. Restarts monitor with resume if dead.
Exit 0 on pass, 2 on fail (still writes the check-in file).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path("/home/evan/Documents/traded-listings-lib")
SCRATCH = Path(
    "/home/evan/.grok/sessions/%2Fhome%2Fevan%2FDocuments/"
    "019fba55-54dc-7312-8992-f4f5626167a0/goal/scratch"
)
ACTIVE = SCRATCH / "active-run.json"
BOOK = REPO / "data/books/full-solana-pokemon/meta.json"
MIN_ROWS = 1000
MIN_PER_PROVIDER = 100


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def proc_alive(run_dir: Path) -> tuple[bool, int | None]:
    pid_path = run_dir / "monitor.pid"
    if not pid_path.exists():
        return False, None
    try:
        pid = int(pid_path.read_text().strip())
    except ValueError:
        return False, None
    try:
        os.kill(pid, 0)
        return True, pid
    except ProcessLookupError:
        pass
    # node child may outlive npm wrapper — scan
    try:
        ps = subprocess.check_output(["ps", "-eo", "pid,cmd"], text=True)
    except Exception:
        return False, pid
    needle = run_dir.name
    for line in ps.splitlines():
        if needle in line and "runtime-monitor" in line:
            try:
                return True, int(line.split()[0])
            except ValueError:
                return True, pid
    return False, pid


def restart_resume(book_dir: Path) -> Path:
    run = REPO / "data/runs" / f"live-resume-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
    run.mkdir(parents=True, exist_ok=True)
    cmd = [
        "npx",
        "tsx",
        "examples/runtime-monitor.ts",
        "--bootstrap",
        "--resume",
        "--max-age-ms",
        "86400000",
        "--seconds",
        "43200",
        "--interval-ms",
        "30000",
        "--max-pages",
        "500",
        "--bids-every",
        "3",
        "--checkpoint-ms",
        "300000",
        "--sample",
        "8",
        "--book-out",
        str(book_dir),
        "--out",
        str(run),
    ]
    with open(run / "monitor.stdout.log", "w") as out, open(
        run / "monitor.stderr.log", "w"
    ) as err:
        p = subprocess.Popen(
            cmd,
            cwd=str(REPO),
            stdout=out,
            stderr=err,
            start_new_session=True,
        )
    (run / "monitor.pid").write_text(str(p.pid) + "\n")
    # wait for meta
    for _ in range(30):
        if (run / "meta.json").exists():
            break
        time.sleep(1)
    ACTIVE.write_text(
        json.dumps({"runDir": str(run), "bookDir": str(book_dir)}, indent=2)
        + "\n"
    )
    return run


def main() -> int:
    SCRATCH.mkdir(parents=True, exist_ok=True)
    (SCRATCH / "checkins").mkdir(exist_ok=True)
    checkins = sorted((SCRATCH / "checkins").glob("*.json"))
    n = len(checkins) + 1
    out_path = SCRATCH / "checkins" / f"{n:02d}.json"

    active = {}
    if ACTIVE.exists():
        active = json.loads(ACTIVE.read_text())
    run_dir = Path(active.get("runDir", ""))
    book_dir = Path(active.get("bookDir", str(BOOK.parent)))

    if not run_dir.exists():
        # recover from latest live-resume-*
        runs = sorted((REPO / "data/runs").glob("live-resume-*"), key=lambda p: p.stat().st_mtime)
        if runs:
            run_dir = runs[-1]
            ACTIVE.write_text(
                json.dumps({"runDir": str(run_dir), "bookDir": str(book_dir)}, indent=2)
                + "\n"
            )

    restarted = False
    alive, pid = proc_alive(run_dir) if run_dir and run_dir.exists() else (False, None)
    if not alive:
        run_dir = restart_resume(book_dir if book_dir.exists() else BOOK.parent)
        restarted = True
        time.sleep(15)
        alive, pid = proc_alive(run_dir)

    book = {}
    if BOOK.exists():
        book = json.loads(BOOK.read_text())

    health = []
    hp = run_dir / "health.jsonl"
    if hp.exists() and hp.stat().st_size:
        health = [json.loads(l) for l in hp.read_text().splitlines() if l.strip()]

    sold = 0
    sp = run_dir / "sold.jsonl"
    if sp.exists():
        sold = sum(1 for l in sp.read_text().splitlines() if l.strip())

    events = 0
    ep = run_dir / "events.jsonl"
    if ep.exists():
        events = sum(1 for l in ep.read_text().splitlines() if l.strip())

    meta = {}
    mp = run_dir / "meta.json"
    if mp.exists():
        meta = json.loads(mp.read_text())

    # per-provider last health
    last_by: dict = {}
    for h in health:
        last_by[h.get("provider")] = h

    row_count = book.get("rowCount") or 0
    by_prov = {k: v.get("rowCount", 0) for k, v in book.get("byProvider", {}).items()}
    collapsed = row_count < MIN_ROWS or any(
        by_prov.get(p, 0) < MIN_PER_PROVIDER
        for p in ("collectorcrypt", "magiceden", "phygitals")
    )

    # progress: health advancing or short-circuits
    health_n = len(health)
    prev = checkins[-1] if checkins else None
    prev_health = 0
    if prev:
        try:
            prev_health = json.loads(prev.read_text()).get("healthLines", 0)
        except Exception:
            pass
    health_delta = health_n - prev_health

    fail_reasons = []
    if not alive:
        fail_reasons.append("process_dead_after_restart_attempt")
    if collapsed:
        fail_reasons.append(f"book_collapsed rows={row_count} by={by_prov}")
    if health_n == 0:
        fail_reasons.append("no_health_lines")
    # stall: no health growth for 2+ checkins while process claims alive
    if prev and health_delta == 0 and n >= 3:
        # allow if last pulls are pure short-circuit with stable actives
        recent = health[-6:]
        if recent and all(r.get("shortCircuited") for r in recent):
            pass
        elif n >= 4 and health_delta == 0:
            # only hard-fail if two consecutive zero deltas
            try:
                p2 = json.loads(checkins[-2].read_text()).get("healthDelta", 1)
            except Exception:
                p2 = 1
            if p2 == 0:
                fail_reasons.append("health_stalled_two_checkins")

    ok = len(fail_reasons) == 0
    payload = {
        "n": n,
        "ts": now_iso(),
        "ok": ok,
        "failReasons": fail_reasons,
        "runDir": str(run_dir),
        "pid": pid,
        "alive": alive,
        "restarted": restarted,
        "skippedCold": meta.get("skippedCold"),
        "healthLines": health_n,
        "healthDelta": health_delta,
        "soldLines": sold,
        "eventLines": events,
        "bookRowCount": row_count,
        "bookByProvider": by_prov,
        "lastByProvider": {
            k: {
                "fetched": v.get("fetched"),
                "activeCount": v.get("activeCount"),
                "pruned": v.get("pruned"),
                "upserted": v.get("upserted"),
                "shortCircuited": v.get("shortCircuited"),
                "softFail": v.get("softFail"),
                "lastError": v.get("lastError"),
            }
            for k, v in last_by.items()
        },
        "stderrTail": "",
    }
    errp = run_dir / "monitor.stderr.log"
    if errp.exists():
        lines = errp.read_text(errors="replace").splitlines()
        payload["stderrTail"] = "\n".join(lines[-15:])

    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps({"n": n, "ok": ok, "alive": alive, "rows": row_count, "health": health_n, "sold": sold, "fail": fail_reasons}))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
