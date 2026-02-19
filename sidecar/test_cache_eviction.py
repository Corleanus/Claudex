#!/usr/bin/env python3
"""Tests for LRU eviction of _mtime_cache and _content_cache in server.py."""

import os
import sys
import tempfile
import unittest
from collections import OrderedDict
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import (
    _content_cache,
    _MAX_CACHE_PROJECTS,
    _mtime_cache,
    _scan_project_files,
)


class TestCacheEviction(unittest.TestCase):
    """Verify that _mtime_cache and _content_cache evict oldest entries at cap."""

    def setUp(self):
        """Clear module-level caches before each test."""
        _mtime_cache.clear()
        _content_cache.clear()

    def tearDown(self):
        _mtime_cache.clear()
        _content_cache.clear()

    def test_cache_type_is_ordered_dict(self):
        self.assertIsInstance(_mtime_cache, OrderedDict)
        self.assertIsInstance(_content_cache, OrderedDict)

    def test_max_cache_projects_value(self):
        self.assertEqual(_MAX_CACHE_PROJECTS, 10)

    def test_eviction_at_cap(self):
        """Scanning 12 projects should keep only the 10 most recent."""
        dirs = []
        for i in range(12):
            d = tempfile.mkdtemp(prefix=f"proj{i:02d}_")
            # Create a single .md file so _scan_project_files finds something
            with open(os.path.join(d, "README.md"), "w") as f:
                f.write(f"project {i}")
            dirs.append(d)

        try:
            for d in dirs:
                _scan_project_files(d, {})

            self.assertEqual(len(_mtime_cache), _MAX_CACHE_PROJECTS)
            self.assertEqual(len(_content_cache), _MAX_CACHE_PROJECTS)

            # The first two (proj00, proj01) should have been evicted
            canon0 = os.path.realpath(dirs[0])
            canon1 = os.path.realpath(dirs[1])
            self.assertNotIn(canon0, _mtime_cache)
            self.assertNotIn(canon0, _content_cache)
            self.assertNotIn(canon1, _mtime_cache)
            self.assertNotIn(canon1, _content_cache)

            # The last 10 (proj02..proj11) should remain
            for d in dirs[2:]:
                canon = os.path.realpath(d)
                self.assertIn(canon, _mtime_cache, f"Expected {canon} in _mtime_cache")
                self.assertIn(canon, _content_cache, f"Expected {canon} in _content_cache")
        finally:
            import shutil
            for d in dirs:
                shutil.rmtree(d, ignore_errors=True)

    def test_lru_order_preserved(self):
        """Re-scanning an older project moves it to end and evicts the next oldest."""
        dirs = []
        for i in range(11):
            d = tempfile.mkdtemp(prefix=f"lru{i:02d}_")
            with open(os.path.join(d, "README.md"), "w") as f:
                f.write(f"project {i}")
            dirs.append(d)

        try:
            # Scan all 11 — after this, dir[0] should be evicted
            for d in dirs:
                _scan_project_files(d, {})

            canon0 = os.path.realpath(dirs[0])
            self.assertNotIn(canon0, _mtime_cache)

            # Now re-scan dir[1] (making it most-recently-used)
            _scan_project_files(dirs[1], {})
            self.assertEqual(len(_mtime_cache), _MAX_CACHE_PROJECTS)

            # dir[1] should still be present (it was just used)
            canon1 = os.path.realpath(dirs[1])
            self.assertIn(canon1, _mtime_cache)

            # Scan a brand-new 12th dir — should evict the oldest remaining (dir[2])
            d12 = tempfile.mkdtemp(prefix="lru12_")
            with open(os.path.join(d12, "README.md"), "w") as f:
                f.write("project 12")
            dirs.append(d12)

            _scan_project_files(d12, {})
            self.assertEqual(len(_mtime_cache), _MAX_CACHE_PROJECTS)

            canon2 = os.path.realpath(dirs[2])
            self.assertNotIn(canon2, _mtime_cache, "dir[2] should be evicted as oldest")
            self.assertIn(canon1, _mtime_cache, "dir[1] should survive (re-scanned)")
        finally:
            import shutil
            for d in dirs:
                shutil.rmtree(d, ignore_errors=True)

    def test_empty_project_dir_cached(self):
        """Scanning an empty dir still populates the cache (with empty dicts)."""
        d = tempfile.mkdtemp(prefix="empty_")
        try:
            _scan_project_files(d, {})
            canon = os.path.realpath(d)
            self.assertIn(canon, _mtime_cache)
            self.assertIn(canon, _content_cache)
            self.assertEqual(_mtime_cache[canon], {})
            self.assertEqual(_content_cache[canon], {})
        finally:
            import shutil
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
