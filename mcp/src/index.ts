#!/usr/bin/env node

import { startServer } from './server.js'

try {
  await startServer()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`velvet-mcp: ${message}`)
  process.exitCode = 1
}
