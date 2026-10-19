export interface NavItem { slug: string; label: string; available: boolean; milestone?: string; summary: string }

/** Every section is listed; unbuilt ones lead to an explicit "not yet available" page, never to mock data. */
export const NAV: NavItem[] = [
  { slug: '', label: 'Overview', available: true, summary: 'Workspace status' },
  { slug: 'monitoring', label: 'Monitoring', available: true, summary: 'Keyword, Boolean and entity monitoring queries per project, matched against collected coverage.' },
  { slug: 'mentions', label: 'Mentions', available: true, summary: 'Search and filter collected coverage with source attribution, publication and discovery timestamps.' },
  { slug: 'alerts', label: 'Issues & alerts', available: false, milestone: 'Milestone 4', summary: 'Configurable, explainable alert rules, spike detection, acknowledgement and escalation.' },
  { slug: 'analytics', label: 'Analytics', available: false, milestone: 'Milestone 4', summary: 'Volume, sentiment, share of voice and source rankings, each with a documented calculation method.' },
  { slug: 'reports', label: 'Reports', available: false, milestone: 'Milestone 5', summary: 'Source-backed PDF and CSV reports, scheduling and report history.' },
  { slug: 'sources', label: 'Sources', available: true, summary: 'Source registry with licence, authorization status, retention and collection health.' },
  { slug: 'projects', label: 'Projects', available: true, summary: 'Monitoring projects' },
  { slug: 'team', label: 'Team', available: true, summary: 'Members, roles and invitations' },
  { slug: 'admin', label: 'Administration', available: true, summary: 'Organization settings and audit log' },
  { slug: 'billing', label: 'Billing', available: false, milestone: 'Milestone 6', summary: 'Subscription plan, usage metering and per-tenant quotas.' },
];
