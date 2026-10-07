# Held-out acceptance check, run by the grader against the final workspace.
# Usage: python3 -I check.py <project-dir>
import sys

sys.path.insert(0, sys.argv[1])
from tabsplit import split_evenly  # noqa: E402

failures = []
for total in [0, 1, 2, 99, 100, 200, 1000, 8450, 9999, 10000, 12345]:
    for people in [1, 2, 3, 4, 6, 7]:
        shares = split_evenly(total, people)
        if len(shares) != people or sum(shares) != total:
            failures.append(f"split_evenly({total}, {people}) = {shares}: wrong count or sum")
        elif max(shares) - min(shares) > 1:
            failures.append(f"split_evenly({total}, {people}) = {shares}: uneven")
        elif shares != sorted(shares, reverse=True):
            failures.append(f"split_evenly({total}, {people}) = {shares}: extra cents not at the front")
for bad in [(100, 0), (-1, 2)]:
    try:
        split_evenly(*bad)
        failures.append(f"split_evenly{bad} did not raise")
    except ValueError:
        pass
print("\n".join(failures) if failures else "ok")
sys.exit(1 if failures else 0)
