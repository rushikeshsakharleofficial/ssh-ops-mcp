"""In-memory MCP v2 protocol test: tool schemas without a live SSH host."""
import unittest

from mcp import Client
from ssh_ops.server import mcp


class MCPProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_tools_list_contains_nine_focused_tools(self):
        async with Client(mcp) as client:
            result = await client.list_tools()
        names = {tool.name for tool in result.tools}
        self.assertEqual(
            names,
            {
                "ssh_profiles", "ssh_save_profile", "ssh_remove_profile",
                "ssh_health", "ssh_run", "ssh_copy", "ssh_incidents",
                "ssh_log_search", "ssh_fleet_health",
            },
        )
        self.assertLess(len(result.tools), 12)


if __name__ == "__main__":
    unittest.main()
