const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { ScaryoClient, GENRES, BASE_URL, HTTP_ROOT } = require("./lib/scaryo");

const manifest = {
  id: "community.scaryo",
  version: "1.1.0",
  name: "Scaryo.tv",
  description: "Browse and stream horror movies from Scaryo.tv (Danish horror streaming). Requires a Scaryo.tv subscription.",
  logo: "https://d2wk81qbuk09ji.cloudfront.net/68067/public/public/system/application_image/SCARYO_digital_Logo_horizontal_Color_White_RGB.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  catalogs: [
    {
      id: "scaryo-all",
      type: "movie",
      name: "Scaryo - All Movies",
      extra: [
        { name: "skip", isRequired: false },
        { name: "search", isRequired: false },
      ],
    },
    ...GENRES.map((g) => ({
      id: `scaryo-${g}`,
      type: "movie",
      name: `Scaryo - ${g.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`,
      extra: [{ name: "skip", isRequired: false }],
    })),
  ],
  idPrefixes: ["scaryo:"],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  config: [
    { key: "email", type: "text", title: "Scaryo.tv Email", required: true },
    { key: "password", type: "password", title: "Scaryo.tv Password", required: true },
  ],
};

const builder = new addonBuilder(manifest);

const clients = new Map();
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getClient(config) {
  const email = (config && config.email) || "";
  const password = (config && config.password) || "";
  const key = email;
  if (!key) return new ScaryoClient("", "");
  if (clients.has(key)) return clients.get(key);
  const client = new ScaryoClient(email, password);
  clients.set(key, client);
  return client;
}

async function ensureAuth(config) {
  const c = getClient(config);
  if (!c.authenticated && c.email && c.password) {
    await c.login();
  }
  return c;
}

function cached(key) {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.ts > CACHE_TTL) return null;
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
  const c = await ensureAuth(config);

  if (extra.search) {
    const results = await c.search(extra.search);
    return {
      metas: results.map((item) => ({
        id: `scaryo:${item.id}`,
        type: "movie",
        name: item.title,
        poster: item.poster || undefined,
      })),
    };
  }

  const genre = id.replace("scaryo-", "");
  const page = Math.floor((parseInt(extra.skip) || 0) / 40) + 1;
  const ck = `cat:${genre}:${page}`;

  let items = cached(ck);
  if (!items) {
    items = await c.getCatalog(genre === "all" ? null : genre, page);
    setCache(ck, items);
  }

  return {
    metas: items.map((item) => ({
      id: `scaryo:${item.id}`,
      type: "movie",
      name: item.title,
      poster: item.poster || undefined,
    })),
  };
});

builder.defineMetaHandler(async ({ type, id, config }) => {
  const slug = id.replace("scaryo:", "");
  const c = await ensureAuth(config);

  const ck = `meta:${slug}`;
  let detail = cached(ck);
  if (!detail) {
    detail = await c.getMovieDetail(slug);
    setCache(ck, detail);
  }

  const meta = {
    id: `scaryo:${slug}`,
    type: "movie",
    name: detail.title,
    description: detail.description || undefined,
    poster: detail.poster || undefined,
    background: detail.poster || undefined,
    genres: detail.genres.length > 0 ? detail.genres : undefined,
    director: detail.director ? [detail.director] : undefined,
    cast: detail.cast.length > 0 ? detail.cast : undefined,
    year: detail.year ? parseInt(detail.year) : undefined,
    runtime: detail.runtime || undefined,
    website: `${HTTP_ROOT}/${slug}`,
  };

  if (detail.imdbId) {
    meta.links = [
      { name: "IMDb", category: "imdb", url: `https://www.imdb.com/title/${detail.imdbId}` },
    ];
  }

  return { meta };
});

builder.defineStreamHandler(async ({ type, id, config }) => {
  const slug = id.replace("scaryo:", "");
  const c = await ensureAuth(config);

  const streams = [];

  if (c.authenticated) {
    const ck = `meta:${slug}`;
    let detail = cached(ck);
    if (!detail) {
      detail = await c.getMovieDetail(slug);
      setCache(ck, detail);
    }

    const playerInfo = await c.getPlayerPage(slug, detail.streamId);

    if (playerInfo.streamUrl) {
      streams.push({
        url: playerInfo.streamUrl,
        name: "Scaryo",
        description: "Direct Stream",
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              Cookie: c.cookies,
              Referer: playerInfo.playerUrl,
              Origin: BASE_URL,
            },
          },
        },
      });
    }

    if (playerInfo.playerUrl && playerInfo.hasContent) {
      streams.push({
        externalUrl: playerInfo.playerUrl,
        name: "Scaryo Player",
        description: "Open in Scaryo web player",
      });
    }
  }

  streams.push({
    externalUrl: `${HTTP_ROOT}/${slug}`,
    name: "Scaryo.tv",
    description: "Open movie page in browser",
  });

  return { streams };
});

const port = parseInt(process.env.PORT) || 7000;

serveHTTP(builder.getInterface(), { port });
console.log(`Scaryo.tv Stremio addon running at http://127.0.0.1:${port}`);
console.log(`Configure & install: http://127.0.0.1:${port}/configure`);
