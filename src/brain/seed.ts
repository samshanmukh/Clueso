// Builds brain/versions/v0.json — the hand-written starting knowledge. Run: tsx src/brain/seed.ts
import fs from 'node:fs';
import path from 'node:path';
import type { BrainVersion } from './store.ts';
import { hash } from './store.ts';

const IMG_PROBE = `
const out = [];
for (const img of document.querySelectorAll('img')) {
  const r = img.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) continue;
  const nW = img.naturalWidth, nH = img.naturalHeight;
  if (!nW || !nH) continue;
  const cs = getComputedStyle(img);
  const px = (k) => parseFloat(cs[k]) || 0;
  const boxW = r.width - px('paddingLeft') - px('paddingRight') - px('borderLeftWidth') - px('borderRightWidth');
  const boxH = r.height - px('paddingTop') - px('paddingBottom') - px('borderTopWidth') - px('borderBottomWidth');
  let dW = boxW, dH = boxH;
  const fit = cs.objectFit;
  if (fit === 'contain' || fit === 'cover' || fit === 'scale-down') {
    let s = fit === 'cover' ? Math.max(boxW / nW, boxH / nH) : Math.min(boxW / nW, boxH / nH);
    if (fit === 'scale-down') s = Math.min(1, s);
    dW = nW * s; dH = nH * s;
  } else if (fit === 'none') { dW = nW; dH = nH; }
  out.push({ technique: 'img', selector: __lp.path(img), href: __lp.linkOf(img), imageUrl: img.currentSrc || img.src,
    naturalW: nW, naturalH: nH, drawnW: dW, drawnH: dH, boxW, boxH, filter: cs.filter, transform: cs.transform, label: img.alt || '' });
}
return out;`.trim();

const v0: BrainVersion = {
  version: 'v0', parent: null, createdAt: new Date().toISOString(), changelog: ['Seed knowledge written by hand'],
  vendors: [
    { id: 'meta-pixel', name: 'Meta Pixel', domains: ['connect.facebook.net', 'facebook.com'], category: 'advertising / conversion tracking',
      collects: ['page views', 'conversion events', 'browser and device identifiers'], policyKeywords: ['meta pixel', 'facebook pixel', 'meta platforms'],
      requiresConsent: true, sources: [{ url: 'https://developers.facebook.com/docs/meta-pixel/' }], addedBy: 'seed' },
    { id: 'google-analytics', name: 'Google Analytics', domains: ['googletagmanager.com', 'google-analytics.com'], category: 'analytics',
      collects: ['page views', 'device and browser data', 'approximate location'], policyKeywords: ['google analytics'],
      requiresConsent: true, sources: [{ url: 'https://developers.google.com/analytics' }], addedBy: 'seed' },
    { id: 'mixpanel', name: 'Mixpanel', domains: ['mxpnl.com', 'mixpanel.com'], category: 'product analytics',
      collects: ['in-app events', 'device data', 'user identifiers'], policyKeywords: ['mixpanel'],
      requiresConsent: true, sources: [{ url: 'https://docs.mixpanel.com/' }], addedBy: 'seed' },
    { id: 'segment', name: 'Twilio Segment', domains: ['segment.com', 'segment.io'], category: 'customer data platform / analytics',
      collects: ['events', 'user traits', 'device data'], policyKeywords: ['segment'],
      requiresConsent: true, sources: [{ url: 'https://segment.com/docs/' }], addedBy: 'seed' },
    { id: 'intercom', name: 'Intercom', domains: ['intercom.io', 'intercomcdn.com'], category: 'customer messaging',
      collects: ['chat messages', 'user identifiers', 'page views'], policyKeywords: ['intercom'],
      requiresConsent: true, sources: [{ url: 'https://developers.intercom.com/' }], addedBy: 'seed' },
    { id: 'stripe', name: 'Stripe', domains: ['js.stripe.com', 'm.stripe.network'], category: 'payments (strictly necessary)',
      collects: ['payment details', 'fraud-prevention signals'], policyKeywords: ['stripe'],
      requiresConsent: false, sources: [{ url: 'https://docs.stripe.com/js' }], addedBy: 'seed' },
  ],
  brands: [
    { id: 'apple-app-store-badge', name: 'Apple App Store badge', linkHosts: ['apps.apple.com', 'itunes.apple.com'], assetHints: ['app-store', 'appstore', 'app store'],
      maxAspectDeviation: 0.06, prohibitFilters: true, prohibitRotation: true,
      guidance: "Apple's App Store marketing guidelines ask that the badge artwork be used as provided: not stretched, recolored, rotated or otherwise altered.",
      sources: [{ url: 'https://developer.apple.com/app-store/marketing/guidelines/' }], addedBy: 'seed' },
    { id: 'google-play-badge', name: 'Google Play badge', linkHosts: ['play.google.com'], assetHints: ['google-play', 'googleplay', 'google play'],
      maxAspectDeviation: 0.06, prohibitFilters: true, prohibitRotation: true,
      guidance: "Google Play's badge guidelines ask that the badge not be distorted, recolored or otherwise modified.",
      sources: [{ url: 'https://partnermarketinghub.withgoogle.com/brands/google-play/' }], addedBy: 'seed' },
  ],
  probes: [
    { id: 'img-elements', name: 'Image elements', description: 'Measures <img> elements: natural vs drawn size (object-fit aware), CSS filter and transform.',
      code: IMG_PROBE, addedBy: 'seed', codeHash: hash(IMG_PROBE) },
  ],
};

const dir = path.resolve('brain');
fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
fs.writeFileSync(path.join(dir, 'versions', 'v0.json'), JSON.stringify(v0, null, 2));
fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ active: 'v0', versions: ['v0'], decisions: [] }, null, 2));
console.log('Seeded brain v0');
