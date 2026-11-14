// Product identity. The internal Pearl build overrides these on its own branch.
export const BRAND = {
  name: 'AITM Desk',
  // Display name shown in the UI and used by the agent to name itself.
  title: 'AITM Desk',
  short: 'AITM Desk',
  dataDir: 'aitm-desk',
  logo: null as string | null,
  /** Name given to the provider migrated from the old single Base URL setting. */
  defaultProviderName: 'Custom endpoint',
  /** Default model for memory compaction ('' = the chat's own model). */
  defaultCompactModel: ''
}
