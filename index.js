const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const crypto = require("crypto");
const { ScaryoClient, GENRES, BASE_URL, HTTP_ROOT } = require("./lib/scaryo");

const manifest = {
  id: "community.scaryo",
  version: "1.2.0",
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
const sessionTokens = new Map();

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

function getSessionToken(email) {
  for (const [token, e] of sessionTokens.entries()) {
    if (e === email) return token;
  }
  const token = crypto.randomBytes(16).toString("hex");
  sessionTokens.set(token, email);
  return token;
}

function renderPlayerPage(title, mpdUrl, licenseUrl, poster) {
  const safeTitle = title.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const jsonMpd = JSON.stringify(mpdUrl);
  const jsonLicense = JSON.stringify(licenseUrl);
  const jsonPoster = JSON.stringify(poster || "");
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle} - Scaryo</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;color:#fff;font-family:system-ui,sans-serif;overflow:hidden}
.wrap{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;position:relative}
video{width:100%;height:100%;background:#000}
#status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
font-size:clamp(16px,3vw,28px);text-align:center;max-width:80%;text-shadow:0 2px 8px #000}
#status.error{color:#f55}
</style>
</head><body>
<div class="wrap">
<video id="v" controls autoplay poster=${jsonPoster}></video>
<div id="status">Loading…</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/shaka-player/5.1.6/shaka-player.compiled.min.js"></script>
<script>
(async()=>{
const st=document.getElementById("status");
shaka.polyfills.installAll();
if(!shaka.Player.isBrowserSupported()){st.className="error";st.textContent="Browser does not support DRM playback.";return}
const v=document.getElementById("v"),p=new shaka.Player();
await p.attach(v);
p.configure({drm:{servers:{"com.widevine.alpha":${jsonLicense}}}});
p.addEventListener("error",e=>{st.className="error";st.textContent="Error: "+(e.detail?.message||e.message||"Unknown")});
try{await p.load(${jsonMpd});st.style.display="none";v.play().catch(()=>{})}
catch(e){st.className="error";st.textContent="Failed: "+e.message}
})();
</script>
</body></html>`;
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

    if (playerInfo.mpdUrl && playerInfo.widevineLicenseUrl) {
      const token = getSessionToken(config.email);
      const publicUrl = process.env.PUBLIC_URL || `http://127.0.0.1:${port}${BASE_PATH}`;
      streams.push({
        externalUrl: `${publicUrl}/play/${token}/${slug}`,
        name: "Scaryo DRM",
        description: `${detail.title || slug} (Widevine)`,
      });
    }

    if (playerInfo.playerUrl && playerInfo.hasContent) {
      streams.push({
        externalUrl: playerInfo.playerUrl,
        name: "Scaryo Web",
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

app.get("/play/:token/:slug", async (req, res) => {
  const email = sessionTokens.get(req.params.token);
  if (!email) {
    res.status(403).send("Invalid or expired session.");
    return;
  }
  const client = clients.get(email);
  if (!client) {
    res.status(403).send("Session not found. Reopen from Stremio.");
    return;
  }
  try {
    if (!client.authenticated) await client.login();
    const detail = await client.getMovieDetail(req.params.slug);
    const player = await client.getPlayerPage(req.params.slug, detail.streamId);
    if (!player.mpdUrl || !player.widevineLicenseUrl) {
      res.status(404).send("No DRM stream available for this title.");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(renderPlayerPage(detail.title, player.mpdUrl, player.widevineLicenseUrl, detail.poster));
  } catch (e) {
    console.error("Play error:", e.message);
    res.status(500).send("Failed to load stream.");
  }
});

app.use(router);

app.listen(port, () => {
  console.log(`Scaryo.tv Stremio addon running at http://127.0.0.1:${port}${BASE_PATH}`);
  console.log(`Configure & install: http://127.0.0.1:${port}${BASE_PATH}/configure`);
});
