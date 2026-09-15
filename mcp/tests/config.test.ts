import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('lists every missing required variable', () => {
    expect(() => loadConfig({})).toThrow(
      'Missing required environment variable(s): VELVET_URL, VELVET_TOKEN, VELVET_WORKSPACE',
    )
    try {
      loadConfig({})
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).missing).toEqual([
        'VELVET_URL',
        'VELVET_TOKEN',
        'VELVET_WORKSPACE',
      ])
    }
  })

  it('normalizes the URL and accepts the optional default status', () => {
    expect(
      loadConfig({
        VELVET_URL: 'https://worklog.example.com/',
        VELVET_TOKEN: 'velvet_test',
        VELVET_WORKSPACE: 'personal',
        VELVET_DEFAULT_STATUS: 'todo',
      }),
    ).toEqual({
      baseUrl: 'https://worklog.example.com',
      token: 'velvet_test',
      workspace: 'personal',
      defaultStatus: 'todo',
    })
  })

  it('rejects an invalid URL and default status', () => {
    expect(() =>
      loadConfig({
        VELVET_URL: 'ftp://worklog.example.com',
        VELVET_TOKEN: 'velvet_test',
        VELVET_WORKSPACE: 'personal',
      }),
    ).toThrow('VELVET_URL must start with http:// or https://')

    expect(() =>
      loadConfig({
        VELVET_URL: 'https://worklog.example.com',
        VELVET_TOKEN: 'velvet_test',
        VELVET_WORKSPACE: 'personal',
        VELVET_DEFAULT_STATUS: 'started',
      }),
    ).toThrow('VELVET_DEFAULT_STATUS must be one of')
  })
})
