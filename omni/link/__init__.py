"""omni.link — the per-machine node agent of hermes-omni.

Bridges the local Hermes dashboard (/api/ws JSON-RPC + REST) to the hub over one outbound
WebSocket, and serves the hub-bridge plugin on :8810. Run with ``python -m omni.link``.
"""
