import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { loadConfig } from './config.js'
import { createMcpServer } from './tools.js'

export async function startServer(): Promise<void> {
  const config = loadConfig()
  const server = createMcpServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
