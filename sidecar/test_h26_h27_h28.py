#!/usr/bin/env python3
"""
Manual test for H26, H27, H28 sidecar server fixes.

Tests:
- H26: JSON array/string instead of dict crashes route_request
- H27: _handle_query reads payload before type validation
- H28: Generic exceptions produce no protocol response

Run this while the sidecar server is running on a known port.
"""

import asyncio
import json
import sys


async def send_request(port: int, data: str):
    """Send raw data to sidecar and return response."""
    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write((data + "\n").encode("utf-8"))
        await writer.drain()

        line = await asyncio.wait_for(reader.readline(), timeout=2.0)
        writer.close()
        await writer.wait_closed()

        return line.decode("utf-8").strip()
    except Exception as e:
        return f"ERROR: {e}"


async def test_h26(port: int):
    """Test H26: Non-dict JSON should return error, not crash."""
    print("\n=== H26: Non-dict JSON ===")

    # Test 1: JSON array
    resp = await send_request(port, '["not", "a", "dict"]')
    print(f"JSON array response: {resp}")
    try:
        r = json.loads(resp)
        if r.get("type") == "error" and "invalid request format" in str(r.get("payload", {})):
            print("✓ H26 array test passed")
        else:
            print(f"✗ H26 array test failed: unexpected response {r}")
    except json.JSONDecodeError:
        print(f"✗ H26 array test failed: invalid JSON response")

    # Test 2: JSON string
    resp = await send_request(port, '"just a string"')
    print(f"JSON string response: {resp}")
    try:
        r = json.loads(resp)
        if r.get("type") == "error" and "invalid request format" in str(r.get("payload", {})):
            print("✓ H26 string test passed")
        else:
            print(f"✗ H26 string test failed: unexpected response {r}")
    except json.JSONDecodeError:
        print(f"✗ H26 string test failed: invalid JSON response")


async def test_h27(port: int):
    """Test H27: Missing type field in query should fail gracefully."""
    print("\n=== H27: Missing type field ===")

    # Request with id but no type field
    resp = await send_request(port, '{"id": "test123", "payload": {"prompt": "hello"}}')
    print(f"Missing type response: {resp}")
    try:
        r = json.loads(resp)
        if r.get("type") == "error" and "type" in str(r.get("payload", {})):
            print("✓ H27 test passed")
        else:
            print(f"✗ H27 test failed: unexpected response {r}")
    except json.JSONDecodeError:
        print(f"✗ H27 test failed: invalid JSON response")


async def test_h28(port: int):
    """Test H28: Generic exceptions should always send error response."""
    print("\n=== H28: Generic exception handling ===")

    # Malformed JSON to trigger exception
    resp = await send_request(port, '{invalid json}')
    print(f"Malformed JSON response: {resp}")
    try:
        r = json.loads(resp)
        if r.get("type") == "error":
            print("✓ H28 test passed (malformed JSON gets error response)")
        else:
            print(f"✗ H28 test failed: unexpected response {r}")
    except json.JSONDecodeError:
        print(f"✗ H28 test failed: no response received (client would hang)")


async def test_valid_ping(port: int):
    """Sanity check: valid ping should still work."""
    print("\n=== Sanity: Valid ping ===")
    resp = await send_request(port, '{"id": "ping1", "type": "ping"}')
    print(f"Ping response: {resp}")
    try:
        r = json.loads(resp)
        if r.get("type") == "pong":
            print("✓ Valid ping works")
        else:
            print(f"✗ Ping failed: {r}")
    except json.JSONDecodeError:
        print(f"✗ Ping failed: invalid JSON response")


async def main():
    if len(sys.argv) < 2:
        print("Usage: python test_h26_h27_h28.py <sidecar_port>")
        print("\nStart the sidecar server first:")
        print("  cd sidecar && python -m server")
        sys.exit(1)

    port = int(sys.argv[1])
    print(f"Testing sidecar server on port {port}")

    await test_valid_ping(port)
    await test_h26(port)
    await test_h27(port)
    await test_h28(port)

    print("\n=== Test complete ===")


if __name__ == "__main__":
    asyncio.run(main())
