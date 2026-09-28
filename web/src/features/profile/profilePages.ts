export const PROFILE_PAGES = [
  { id: 'general', label: 'General', description: 'Your personal identity across organisations.' },
  { id: 'github', label: 'GitHub', description: 'Manage the GitHub identity that attributes your work.' },
  { id: 'agent-config', label: 'Agent config', description: 'Connect coding agents and configure repository instructions.' },
  { id: 'tokens', label: 'API tokens', description: 'Manage personal access for tools and coding agents.' },
] as const

export type ProfilePageId = typeof PROFILE_PAGES[number]['id']
