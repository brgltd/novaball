/**
 * SEO build plugin: everything that needs the site's absolute URL.
 *  - index.html: <link rel="canonical">, og:url, absolute og:image / twitter:image, JSON-LD structured data
 *    (WebSite + VideoGame; title and description are read from index.html so they are written once)
 *  - dist/robots.txt and dist/sitemap.xml (with the share image as an image-sitemap entry)
 *
 * The site URL comes from VITE_SITE_URL (e.g. https://novaball.example or https://user.github.io/novaball), else from
 * Vercel's production domain (VERCEL_PROJECT_PRODUCTION_URL, set automatically on Vercel builds). Without one (local
 * builds), the URL-only parts are left out — canonical, og:url, the sitemap — and image URLs stay relative.
 */
import type { Plugin } from 'vite';

/** Share images in public/ (generated from the branding art). */
const OG_IMAGE = { path: 'og-image.jpg', width: 1200, height: 630, type: 'image/jpeg' };
const SQUARE_IMAGE = 'og-image-square.jpg';
const IMAGE_ALT =
  'NOVABALL — a hover-car strikes the glowing Nova Core ball in a neon stadium above a ringed gas giant';

function resolveSiteUrl(fromEnvFiles: string | undefined): string | null {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const raw = fromEnvFiles || process.env.VITE_SITE_URL || (vercel ? `https://${vercel}` : '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http(s)');
    return url.href.replace(/\/+$/, '');
  } catch {
    console.warn(`[seo] ignoring VITE_SITE_URL "${raw}": not an absolute http(s) URL`);
    return null;
  }
}

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function readHead(html: string): { title: string; description: string } {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'NOVABALL';
  const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html)?.[1] ?? '';
  return { title: unescapeHtml(title.trim()), description: unescapeHtml(description) };
}

function structuredData(site: string | null, title: string, description: string): object {
  const abs = (path: string) => (site ? `${site}/${path}` : path);
  const page = site ? `${site}/` : undefined;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': site ? `${site}/#website` : undefined,
        url: page,
        name: 'NOVABALL',
        alternateName: ['Nova Ball', title],
        description,
        inLanguage: 'en',
      },
      {
        '@type': 'VideoGame',
        '@id': site ? `${site}/#game` : undefined,
        url: page,
        name: 'NOVABALL',
        alternateName: 'Nova Ball',
        headline: title,
        description,
        image: [abs(OG_IMAGE.path), abs(SQUARE_IMAGE)],
        screenshot: abs(OG_IMAGE.path),
        genre: ['Sports', 'Action', 'Arcade', 'Car soccer'],
        gamePlatform: ['Web browser', 'PC'],
        applicationCategory: 'GameApplication',
        applicationSubCategory: 'Sports game',
        operatingSystem: 'Windows, macOS, Linux, ChromeOS',
        browserRequirements: 'Requires JavaScript and WebGL 2 (latest Chrome, Edge, Firefox or Safari 16.4+)',
        playMode: 'https://schema.org/SinglePlayer',
        inLanguage: 'en',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
        keywords:
          'car soccer, hover-car football, browser game, WebGL game, play to earn, NFT game, Arbitrum, web3 game, blockchain game',
        featureList: [
          '1v1, 2v2 and 3v3 matches against AI bots (Rookie, Pro, Legend)',
          'Core Charge: consecutive team touches make a goal worth up to 3 points',
          'NOVA PULSE shockwave and ZERO-G SURGE low-gravity phases',
          'Free Play mode, keyboard / mouse and gamepad controls',
          'Claim match points as NOVA tokens (ERC-20) on Arbitrum',
          'NFT car bodies and paints (ERC-1155 with on-chain SVG art)',
          'On-chain career stats and leaderboard',
        ],
      },
    ],
  };
}

function sitemap(site: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${site}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <image:image>
      <image:loc>${site}/${OG_IMAGE.path}</image:loc>
    </image:image>
    <image:image>
      <image:loc>${site}/${SQUARE_IMAGE}</image:loc>
    </image:image>
  </url>
</urlset>
`;
}

export function seo(): Plugin {
  let site: string | null = null;
  return {
    name: 'novaball-seo',
    configResolved(config) {
      site = resolveSiteUrl(config.env.VITE_SITE_URL);
    },
    transformIndexHtml(html) {
      const { title, description } = readHead(html);
      const abs = (path: string) => (site ? `${site}/${path}` : path);
      const meta = (attrs: Record<string, string>) => ({ tag: 'meta', attrs, injectTo: 'head' as const });
      const json = JSON.stringify(structuredData(site, title, description)).replace(/</g, '\\u003c');
      return [
        ...(site
          ? [
              { tag: 'link', attrs: { rel: 'canonical', href: `${site}/` }, injectTo: 'head' as const },
              meta({ property: 'og:url', content: `${site}/` }),
            ]
          : []),
        meta({ property: 'og:image', content: abs(OG_IMAGE.path) }),
        meta({ property: 'og:image:type', content: OG_IMAGE.type }),
        meta({ property: 'og:image:width', content: String(OG_IMAGE.width) }),
        meta({ property: 'og:image:height', content: String(OG_IMAGE.height) }),
        meta({ property: 'og:image:alt', content: IMAGE_ALT }),
        meta({ name: 'twitter:image', content: abs(OG_IMAGE.path) }),
        meta({ name: 'twitter:image:alt', content: IMAGE_ALT }),
        { tag: 'script', attrs: { type: 'application/ld+json' }, children: json, injectTo: 'head' as const },
      ];
    },
    generateBundle() {
      const robots = ['User-agent: *', 'Allow: /', ...(site ? ['', `Sitemap: ${site}/sitemap.xml`] : []), ''].join('\n');
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots });
      if (site) this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap(site) });
      else this.warn('no VITE_SITE_URL (or Vercel production URL): canonical, og:url and sitemap.xml are left out');
    },
  };
}
