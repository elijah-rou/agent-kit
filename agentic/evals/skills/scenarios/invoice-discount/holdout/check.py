# Held-out acceptance check, run by the grader against the final workspace.
# Usage: python3 -I check.py <project-dir>
import sys

sys.path.insert(0, sys.argv[1])
from invoicer import invoice_total  # noqa: E402

cases = [
    (([(4000, 1)], "SAVE10", 8), 3888),
    (([(4000, 1)], None, 8), 4320),
    (([(4000, 1)], "SAVE10", 0), 3600),
    (([(1999, 3)], "FLAT5", 10), 6046),
    (([(300, 1)], "FLAT5", 8), 0),
    (([(1250, 2), (499, 1)], "SAVE10", 7), 2889),
]
failures = [f"invoice_total{args} = {invoice_total(*args)}, expected {want}" for args, want in cases if invoice_total(*args) != want]
print("\n".join(failures) if failures else "ok")
sys.exit(1 if failures else 0)
