const fetch = require("node-fetch");
const cheerio = require("cheerio");

const BASE_URL = "https://www.scaryo.tv";
const HTTP_ROOT = `${BASE_URL}/da`;

const GENRES = [
  "psykologisk", "monster", "paranormal", "slash-kill",
  "body-horror", "sci-fi", "horror-komedie", "splatter",
  "apokalyptisk", "vintage", "thriller",
];

class ScaryoClient {
  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.cookies = "";
    this.csrfToken = "";
    this.authenticated = false;
  }

  _headers(extra) {
    const h = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "da,en;q=0.9",
      "Referer": `${HTTP_ROOT}/`,
      ...extra,
    };
    if (this.cookies) h["Cookie"] = this.cookies;
    return h;
  }

  _parseCookies(response) {
    const raw = response.headers.raw()["set-cookie"];
    if (!raw) return;
    const map = {};
    if (this.cookies) {
      for (const p of this.cookies.split("; ")) {
        const eq = p.indexOf("=");
        if (eq > 0) map[p.substring(0, eq)] = p;
      }
    }
    for (const c of raw) {
      const pair = c.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) map[pair.substring(0, eq)] = pair;
    }
    this.cookies = Object.values(map).join("; ");
  }

  async _fetchCsrf() {
    const res = await fetch(`${HTTP_ROOT}/`, {
      headers: this._headers(),
      redirect: "follow",
    });
    this._parseCookies(res);
    const html = await res.text();
    const $ = cheerio.load(html);
    this.csrfToken = $('input[name="csrfToken"]').first().val() || "";
    return this.csrfToken;
  }

  async _doLogin() {
    const body = new URLSearchParams();
    body.append("csrfToken", this.csrfToken);
    body.append("LoginForm[email]", this.email);
    body.append("LoginForm[password]", this.password);

    const res = await fetch(`${HTTP_ROOT}/user/ajaxlogin`, {
      method: "POST",
      headers: this._headers({
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
      }),
      body: body.toString(),
      redirect: "manual",
    });
    this._parseCookies(res);

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    return data;
  }

  async login() {
    if (!this.email || !this.password) return false;
    try {
      if (!this.csrfToken) await this._fetchCsrf();

      let data = await this._doLogin();

      if (data.login === "invalid_token") {
        if (data.csrfToken) {
          this.csrfToken = data.csrfToken;
        } else {
          this.csrfToken = "";
          this.cookies = "";
          await this._fetchCsrf();
        }
        data = await this._doLogin();
      }

      if (data.login === "success") {
        this.authenticated = true;
        if (data.csrfToken) this.csrfToken = data.csrfToken;
        console.log("Scaryo login successful");
        return true;
      }

      console.warn("Scaryo login response:", data.login || JSON.stringify(data).substring(0, 200));
      return false;
    } catch (e) {
      console.error("Login error:", e.message);
      return false;
    }
  }

  async _fetchHtml(url) {
    const res = await fetch(url, { headers: this._headers(), redirect: "follow" });
    this._parseCookies(res);
    return cheerio.load(await res.text());
  }

  async getCatalog(genre, page = 1) {
    let url;
    if (genre && genre !== "all") {
      url = `${HTTP_ROOT}/genre/${genre}?p=${page}`;
    } else {
      url = `${HTTP_ROOT}/movie?p=${page}`;
    }

    const $ = await this._fetchHtml(url);
    const items = [];

    $("a.playbtn, .playbtn").each((_, el) => {
      const a = $(el);
      const permalink = a.attr("data-content-permalink");
      if (!permalink) return;
      if (items.find((i) => i.id === permalink)) return;

      const title = a.attr("data-content_title") || a.attr("data-name") || permalink;
      const movieId = a.attr("data-movie_id") || "";
      const isPPV = a.attr("data-isppv") || "0";
      const streamId = a.attr("data-stream_id") || "0";

      const item = a.closest(".item.clearfix");
      const poster = item.find(".poster-cover").attr("src") || "";

      items.push({
        id: permalink,
        title,
        movieId,
        poster,
        isPPV: isPPV === "1",
        streamId,
      });
    });

    return items;
  }

  async getMovieDetail(slug) {
    const $ = await this._fetchHtml(`${HTTP_ROOT}/${slug}`);

    const title = ($("h1").first().text().trim() ||
                  ($('meta[property="og:title"]').attr("content") || "").trim() || slug).trim();
    const description = (($('meta[property="og:description"]').attr("content") ||
                        $('meta[name="description"]').attr("content") || "")).trim();
    const poster = $('meta[property="og:image"]').attr("content") || "";

    let imdbId = "";
    $('a[href*="imdb.com/title/"]').each((_, el) => {
      const href = $(el).attr("href") || "";
      const m = href.match(/imdb\.com\/title\/(tt\d+)/);
      if (m) imdbId = m[1];
    });

    const playBtn = $("a.playbtn, .playbtn").first();
    const movieId = playBtn.attr("data-movie_id") || "";
    const streamId = playBtn.attr("data-stream_id") || "0";

    const bodyText = $("body").text();
    let year = "";
    const yearMatch = bodyText.match(/\b(19\d{2}|20[0-2]\d)\b/);
    if (yearMatch) year = yearMatch[1];

    let runtime = "";
    const timeMatch = bodyText.match(/(\d+)\s*(?:hour|time)[s]?\s*(\d+)\s*min/i);
    if (timeMatch) runtime = `${timeMatch[1]}h ${timeMatch[2]}m`;

    const genres = [];
    GENRES.forEach((g) => {
      if ($(`a[href*="/genre/${g}"]`).length > 0) {
        genres.push(g.replace(/-/g, " "));
      }
    });

    let director = "";
    $("body *").each((_, el) => {
      const t = $(el).text().trim();
      const dm = t.match(/^(?:Director|Instruktør):?\s*(.+)/i);
      if (dm && dm[1].length < 100) {
        director = dm[1].trim();
        return false;
      }
    });

    const cast = [];
    $("body *").each((_, el) => {
      const t = $(el).text().trim();
      const cm = t.match(/^(?:Cast|Skuespillere):?\s*(.+)/i);
      if (cm && cm[1].length < 300) {
        cm[1].split(",").forEach((c) => {
          const name = c.trim();
          if (name) cast.push(name);
        });
        return false;
      }
    });

    return {
      slug,
      title,
      description,
      poster,
      imdbId,
      movieId,
      streamId,
      year,
      runtime,
      genres,
      director,
      cast,
    };
  }

  async getStreamInfo(slug, movieId, streamId) {
    if (!this.authenticated) return null;

    try {
      const body = new URLSearchParams();
      body.append("csrfToken", this.csrfToken);
      body.append("movie_id", movieId);
      body.append("stream_id", streamId || "0");
      body.append("content_title", slug);
      body.append("content_type", "1");

      const res = await fetch(`${HTTP_ROOT}/user/chkPemission/`, {
        method: "POST",
        headers: this._headers({
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
        }),
        body: body.toString(),
        redirect: "follow",
      });
      this._parseCookies(res);

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      return data;
    } catch (e) {
      console.error("Permission check error:", e.message);
      return null;
    }
  }

  async getPlayerPage(slug, streamUniqId) {
    const sid = streamUniqId || "0";
    const url = `${HTTP_ROOT}/player/${slug}/stream/${sid}`;

    try {
      const res = await fetch(url, { headers: this._headers(), redirect: "follow" });
      this._parseCookies(res);
      const html = await res.text();

      let streamUrl = "";

      const m3u8 = html.match(/(https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/);
      if (m3u8) streamUrl = m3u8[1];

      if (!streamUrl) {
        const mpd = html.match(/(https?:\/\/[^"'\s\\]+\.mpd[^"'\s\\]*)/);
        if (mpd) streamUrl = mpd[1];
      }

      if (!streamUrl) {
        const src = html.match(/(?:stream_url|hls_url|video_url|dash_url)\s*[:=]\s*["'](https?:\/\/[^"']+)/i);
        if (src) streamUrl = src[1];
      }

      let mpdUrl = "";
      const mpdRe = html.match(/(https?:\/\/[^"'\s\\]+\.mpd[^"'\s\\]*)/);
      if (mpdRe) mpdUrl = mpdRe[1];

      let widevineLicenseUrl = "";
      const licenseMatches = [...html.matchAll(/licenseUrl\s*[:=]\s*["'](https?:\/\/license\.pallycon\.com[^"']+)/gi)];
      for (const lm of licenseMatches) {
        try {
          const b64 = lm[1].match(/pallycon-customdata-v2=([A-Za-z0-9+/=]+)/);
          if (b64) {
            const decoded = Buffer.from(b64[1], "base64").toString();
            if (decoded.includes('"Widevine"')) {
              widevineLicenseUrl = lm[1];
              break;
            }
          }
        } catch {}
      }

      return {
        streamUrl,
        mpdUrl,
        widevineLicenseUrl,
        playerUrl: url,
        hasContent: html.length > 1000,
      };
    } catch (e) {
      console.error("Player page error:", e.message);
      return { streamUrl: "", licenseUrl: null, playerUrl: url, hasContent: false };
    }
  }

  async search(query) {
    try {
      const url = `${HTTP_ROOT}/search/show_all?search_field=${encodeURIComponent(query)}`;
      const $ = await this._fetchHtml(url);
      const items = [];

      $("a.playbtn, .playbtn").each((_, el) => {
        const a = $(el);
        const permalink = a.attr("data-content-permalink");
        if (!permalink) return;
        if (items.find((i) => i.id === permalink)) return;

        const title = a.attr("data-content_title") || a.attr("data-name") || permalink;
        const movieId = a.attr("data-movie_id") || "";
        const item = a.closest(".item.clearfix");
        const poster = item.find(".poster-cover").attr("src") || "";

        items.push({ id: permalink, title, movieId, poster, isPPV: false, streamId: "0" });
      });

      return items;
    } catch {
      return [];
    }
  }
}

module.exports = { ScaryoClient, GENRES, BASE_URL, HTTP_ROOT };
