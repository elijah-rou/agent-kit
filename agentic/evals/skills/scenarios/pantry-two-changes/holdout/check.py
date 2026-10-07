# Held-out acceptance check, run by the grader against a checkout of the final HEAD.
# Exercises the command line, so it does not depend on where the candidate put the change.
# Usage: python3 -I check.py <project-dir>
import json
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

project = Path(sys.argv[1]).resolve()
today = date.today()
items = [
    {"name": "milk", "quantity": "1 l", "best_before": (today + timedelta(days=1)).isoformat()},
    {"name": "flour", "quantity": "1.5 kg"},
    {"name": "Greek yoghurt", "quantity": "500 g", "best_before": (today + timedelta(days=2)).isoformat()},
    {"name": "basmati rice", "quantity": "2 kg", "best_before": (today + timedelta(days=200)).isoformat()},
    {"name": "apples", "quantity": "4", "best_before": (today + timedelta(days=30)).isoformat()},
]
failures = []
with tempfile.TemporaryDirectory() as tmp:
    data = Path(tmp) / "pantry.json"
    data.write_text(json.dumps(items))

    def run(*args):
        return subprocess.run([sys.executable, "-m", "pantry", "--file", str(data), *args], cwd=project, capture_output=True, text=True)

    expiring = run("expiring")
    if expiring.returncode != 0:
        failures.append(f"expiring exited {expiring.returncode}: {expiring.stderr.strip().splitlines()[-1:]}")
    else:
        shown = [i["name"] for i in items if i["name"] in expiring.stdout]
        if sorted(shown) != ["Greek yoghurt", "milk"]:
            failures.append(f"expiring showed {shown}")
    listed = run("list")
    if listed.returncode != 0:
        failures.append(f"list exited {listed.returncode}")
    else:
        order = sorted((listed.stdout.find(i["name"]), i["name"]) for i in items)
        names = [name for position, name in order if position >= 0]
        if names != ["apples", "basmati rice", "flour", "Greek yoghurt", "milk"]:
            failures.append(f"list order is {names}")
print("\n".join(failures) if failures else "ok")
sys.exit(1 if failures else 0)
