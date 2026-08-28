const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
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
      const stream = {
        url: playerInfo.streamUrl,
        name: "Scaryo",
        description: detail.title || "Direct Stream",
      };
      if (playerInfo.streamUrl.includes("cloudfront.net")) {
        stream.behaviorHints = { notWebReady: false };
      }
      streams.push(stream);
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
const BASE_PATH = process.env.BASE_PATH || "";

const app = express();
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

if (BASE_PATH) {
  app.get("/configure", (req, res) => {
    const page = `<!DOCTYPE html>
<html style="background-image:url(https://dl.strem.io/addon-background.jpg);">
<head>
<meta charset="utf-8"><title>Scaryo.tv - Stremio Addon</title>
<link href="https://fonts.googleapis.com/css?family=Open+Sans:400,600,700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body,html{margin:0;padding:0;width:100%;min-height:100%}
html{background-size:cover;background-position:center;box-shadow:inset 0 0 0 2000px rgb(0 0 0/60%)}
body{padding:4vh;font-size:2.2vh;display:flex;font-family:'Open Sans',Arial,sans-serif;color:#fff}
h1{font-size:4.5vh;font-weight:700}h2{font-size:2.2vh;font-weight:normal;font-style:italic;opacity:.8}
#addon{width:40vh;margin:auto}.logo{height:14vh;width:14vh;margin:auto auto 3vh}
.logo img{width:100%}.separator{margin-bottom:4vh}.form-element{margin-bottom:2vh}
.label-to-top{margin-bottom:1vh}.full-width{width:100%;padding:.8vh;font-size:2vh}
button{border:0;outline:0;color:#fff;background:#8A5AAB;padding:1.2vh 3.5vh;margin:auto;
text-align:center;font-family:'Open Sans',Arial,sans-serif;font-size:2.2vh;font-weight:600;
cursor:pointer;display:block;box-shadow:0 .5vh 1vh rgba(0,0,0,.2)}
button:hover{box-shadow:none}a.install-link{text-decoration:none}</style>
</head><body><div id="addon">
<div class="logo"><img src="${addonInterface.manifest.logo}"></div>
<h1>${addonInterface.manifest.name}</h1>
<h2>v${addonInterface.manifest.version}</h2>
<h2>${addonInterface.manifest.description}</h2>
<div class="separator"></div>
<form class="pure-form" id="mainForm">
<div class="form-element"><div class="label-to-top">Scaryo.tv Email</div>
<input type="text" id="email" name="email" class="full-width" required/></div>
<div class="form-element"><div class="label-to-top">Scaryo.tv Password</div>
<input type="password" id="password" name="password" class="full-width" required/></div>
</form>
<div class="separator"></div>
<a id="installLink" class="install-link" href="#">
<button>INSTALL</button></a>
</div>
<script>
installLink.onclick=()=>mainForm.reportValidity();
function updateLink(){
  const config=Object.fromEntries(new FormData(mainForm));
  installLink.href='stremio://'+location.host+'${BASE_PATH}/'+encodeURIComponent(JSON.stringify(config))+'/manifest.json';
}
mainForm.onchange=updateLink;
updateLink();
</script></body></html>`;
    res.setHeader("Content-Type", "text/html");
    res.end(page);
  });
}

app.use(router);

app.listen(port, () => {
  console.log(`Scaryo.tv Stremio addon running at http://127.0.0.1:${port}${BASE_PATH}`);
  console.log(`Configure & install: http://127.0.0.1:${port}${BASE_PATH}/configure`);
});
