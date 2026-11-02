// The multiplayer API is a persistent Node.js service hosted separately from Vercel.
const rawOrigin = (process.env.BLOKUS_API_ORIGIN || '').trim();
if (!rawOrigin) {
  throw new Error('BLOKUS_API_ORIGIN is required. Set it to the public Render service URL (https://...onrender.com) before deploying.');
}

let apiOrigin;
try {
  const url = new URL(rawOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Expected an HTTPS origin with no path, query, or credentials.');
  }
  apiOrigin = url.origin;
} catch (error) {
  throw new Error('Invalid BLOKUS_API_ORIGIN: ' + error.message);
}

export const config = {
  framework: null,
  buildCommand: 'node scripts/build-static.mjs',
  outputDirectory: 'dist',
  rewrites: [
    { source: '/api/:path*', destination: apiOrigin + '/api/:path*' }
  ]
};
