"""Allow running the sidecar package as `python <sidecar_dir>`."""
import sys
import os

# When Python runs a directory, the directory is added to sys.path but the
# package context is not set up, so relative imports in main.py fail.
# Fix: add the PARENT directory to sys.path so `sidecar` is importable as a package.
_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _parent not in sys.path:
    sys.path.insert(0, _parent)

from sidecar.main import main

main()
