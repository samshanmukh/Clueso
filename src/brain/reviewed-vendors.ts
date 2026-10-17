import type { Vendor } from './store.ts';

/** Reviewed from first-party documentation; consent context is intentionally not a legal verdict. */
export const cloudflareWebAnalytics: Vendor = {
  id: 'cloudflare-web-analytics', name: 'Cloudflare Web Analytics',
  domains: ['cloudflareinsights.com'],
  category: 'cookieless website analytics and performance monitoring',
  collects: ['page views', 'page URLs', 'referring pages', 'page-load timing and Core Web Vitals'],
  policyKeywords: ['cloudflare', 'cloudflare web analytics', 'cloudflare insights'],
  requiresConsent: null,
  consentRationale: 'Cloudflare documents this beacon as cookieless performance analytics without cross-site visitor tracking. Loading it before interaction alone does not establish a consent violation; requirements depend on the deployment and applicable rules.',
  sources: [
    { url: 'https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/', quote: 'The Web Analytics performance beacon loads from https://static.cloudflareinsights.com/beacon.min.js.' },
    { url: 'https://www.cloudflare.com/web-analytics/', quote: 'Cloudflare Web Analytics does not use any client-side state, such as cookies or localStorage, to collect usage metrics.' },
  ],
  addedBy: 'maintainer review of observed beacon and official Cloudflare documentation',
};
