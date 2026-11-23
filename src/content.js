// claims everything free in the item shop while the pirate token is active.
// always sends expectedTotalPrice 0, epic rejects the claim if the item isn't actually free
(() => {
  if (window.__pirateTokenClaimAll) return;
  window.__pirateTokenClaimAll = true;

  const SHOP_RE = /^\/item-shop\/?$/;
  // one request at a time: Epic answers 429 when claims are fired in parallel
  const REQUEST_GAP_MS = 1200;
  const RATE_LIMIT_RETRIES = 8;
  const RATE_LIMIT_BASE_MS = 5000;
  const RATE_LIMIT_MAX_MS = 5 * 60 * 1000;
  const STOPPED = 'Stopped';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nativeFetch = window.fetch.bind(window);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // shared gate: minimum gap between requests plus a global pause after a 429
  const gate = { nextAt: 0, blockedUntil: 0, onWait: null, onResume: null };

  const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));

  // Epic usually sends Retry-After in seconds; accept an HTTP date too
  function retryAfterMs(r) {
    const h = r.headers.get('retry-after');
    if (!h) return 0;
    const s = Number(h);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
  }

  async function waitForGate() {
    for (;;) {
      if (state.stopped) throw new Error(STOPPED);
      const left = Math.max(gate.nextAt, gate.blockedUntil) - Date.now();
      if (left <= 0) return;
      gate.onWait?.(Math.ceil(left / 1000));
      await sleep(Math.min(1000, left));
    }
  }

  async function epicFetch(url, init) {
    for (let attempt = 0; ; attempt++) {
      await waitForGate();
      const r = await nativeFetch(url, init);
      if (r.status !== 429 && r.status !== 503) {
        gate.blockedUntil = 0;
        gate.nextAt = Date.now() + jitter(REQUEST_GAP_MS);
        gate.onResume?.();
        return r;
      }
      if (attempt >= RATE_LIMIT_RETRIES) {
        throw new Error(`Epic keeps answering HTTP ${r.status}. Wait a few minutes and press Try again`);
      }
      const backoff = Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_BASE_MS * 2 ** attempt);
      gate.blockedUntil = Date.now() + jitter(Math.max(retryAfterMs(r), backoff));
      gate.nextAt = gate.blockedUntil;
    }
  }

  function decodeTS(text) {  // epic's .data responses come in this format
    const arr = JSON.parse(text);
    const SPECIAL = { '-1': undefined, '-2': null, '-3': NaN, '-4': Infinity, '-5': -Infinity, '-6': -0, '-7': undefined };
    const cache = new Map();
    const h = (i) => {
      if (typeof i !== 'number') return i;
      if (i < 0) return SPECIAL[i];
      if (cache.has(i)) return cache.get(i);
      const v = arr[i];
      if (Array.isArray(v)) {
        if (typeof v[0] === 'string') {
          if (v[0] === 'D') { const d = new Date(v[1]).toISOString(); cache.set(i, d); return d; }
          if (v[0] === 'Z') { const o = {}; cache.set(i, o); return o; }
          return v;
        }
        const out = []; cache.set(i, out);
        for (const x of v) out.push(h(x));
        return out;
      }
      if (v && typeof v === 'object') {
        const out = {}; cache.set(i, out);
        for (const k of Object.keys(v)) out[arr[+k.slice(1)]] = h(v[k]);
        return out;
      }
      return v;
    };
    return h(0);
  }

  async function getData(url) {
    const r = await epicFetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`Epic's site answered with an error (HTTP ${r.status})`);
    return decodeTS(await r.text());
  }

  function collectOffers(root) {
    const offers = new Map();
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || depth > 16 || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (typeof o.offerId === 'string' && o.pricing) { if (!offers.has(o.offerId)) offers.set(o.offerId, o); return; }
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    })(root, 0);
    return [...offers.values()];
  }

  async function loadShop() {
    const d = await getData('/item-shop.data?_routes=routes%2Fitem-shop._index');
    const data = d?.['routes/item-shop._index']?.data;
    if (!data) throw new Error("Couldn't read the Item Shop");
    return { loggedIn: data.isLoggedIn !== false, offers: collectOffers(data) };
  }

  async function getCsrf() {
    const d = await getData('/item-shop/resources/csrf-token.data?_routes=routes%2Fitem-shop.resources.csrf-token');
    const t = d?.['routes/item-shop.resources.csrf-token']?.data?.csrfToken;
    if (!t) throw new Error("Couldn't get a security token from Epic");
    return t;
  }

  async function getBalance() {
    try {
      const d = await getData('/item-shop/resources/get-profile.data?_routes=routes%2Fitem-shop.resources.get-profile');
      const b = d?.['routes/item-shop.resources.get-profile']?.data?.fortniteProfile?.vbucksWallet?.balance;
      return typeof b === 'number' ? b : null;
    } catch (_) { return null; }
  }

  const isFree = (o) => o.pricing?.finalPrice === 0 && o.pricing?.currencyType === 'MtxCurrency';
  const isBundle = (o) => o.assetType === 'dynamicbundle' || /bundle/i.test(o.offerMainType || '');
  const owned = (o) => o.ownershipStatus === 'owned';
  // with the token pretty much everything that costs v-bucks shows up as free
  const hasToken = (offers) => {
    const vb = offers.filter((o) => o.pricing?.currencyType === 'MtxCurrency');
    return vb.length > 0 && vb.filter(isFree).length > vb.length / 2;
  };
  const thumb = (o) => { const im = Array.isArray(o.image) ? o.image[0] : o.image; return im?.sm || im?.xs || im?.md || ''; };

  async function claim(offer, csrf) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r, d = null;
      try {
        r = await epicFetch('/item-shop/purchase.data', {
          method: 'POST',
          credentials: 'include',
          body: new URLSearchParams({ csrfToken: csrf.value, offerId: offer.offerId, expectedTotalPrice: '0' }),
        });
        d = decodeTS(await r.text())?.data;
      } catch (e) {
        const why = String(e?.message || e);
        if (why === STOPPED) return { result: 'stopped' };
        if (/429|limit/i.test(why)) return { result: 'failed', why };
        d = { success: false, error: why };
      }
      if (d?.success) {
        const items = (d.data?.notifications || []).flatMap((n) => n.lootResult?.items || []);
        return { result: 'claimed', granted: items.length };
      }
      const err = String(d?.error || `HTTP ${r?.status}`).replace(/^HttpError:\s*/, '');
      if (/already own/i.test(err)) return { result: 'owned' };
      if (/csrf/i.test(err) && attempt === 0) { csrf.value = await getCsrf(); continue; }
      // the request layer already retried 429/503; this covers soft errors in the body
      if (/throttl|too many|rate limit|timeout|temporar/i.test(err)) {
        await sleep(jitter(RATE_LIMIT_BASE_MS * (attempt + 1)));
        continue;
      }
      return { result: 'failed', why: err.slice(0, 140) };
    }
    return { result: 'failed', why: 'Epic asked us to slow down. Try again in a minute' };
  }

  // claims are strictly sequential so a burst never trips the limiter
  async function each(items, worker) {
    for (const item of items) {
      if (state.stopped) return;
      await worker(item);
    }
  }

  const state = { running: false, stopped: false, remaining: null };

  async function run() {
    if (state.running) return;
    state.running = true; state.stopped = false;
    syncHero();
    const ui = openModal();
    const t0 = performance.now();
    const stats = { claimed: 0, viaBundle: 0, owned: 0, failed: [], granted: 0 };
    let waiting = false;
    gate.onWait = (s) => { waiting = true; ui.status(`Epic is asking us to slow down. Waiting ${s}s…`); };
    gate.onResume = () => { if (waiting) { waiting = false; ui.status('Claiming…'); } };
    try {
      ui.status('Reading the shop…');
      // sequential on purpose: three parallel reads are enough to get a 429
      const shop = await loadShop();
      if (!shop.loggedIn) { ui.notice('signin'); return; }
      if (!hasToken(shop.offers)) { ui.notice('notoken'); return; }
      const csrf = { value: await getCsrf() };
      const startBal = await getBalance();

      const unowned = shop.offers.filter((o) => !owned(o));
      const targets = unowned.filter(isFree);
      const notCovered = unowned.filter((o) => !isFree(o));

      if (!targets.length) { ui.done({ ...stats, notCovered, nothing: true, seconds: 0 }); state.remaining = 0; return; }
      ui.build(targets);

      const count = () => ui.progress(stats.claimed + stats.viaBundle + stats.owned + stats.failed.length);
      const work = async (o) => {
        ui.tile(o.offerId, 'working');
        const r = await claim(o, csrf);
        if (r.result === 'claimed') { stats.claimed++; stats.granted += r.granted; ui.toast(o); }
        else if (r.result === 'owned') stats.owned++;
        else if (r.result !== 'stopped') stats.failed.push({ title: o.title, why: r.why });
        ui.tile(o.offerId, r.result, r.why);
        count();
      };

      const bundles = targets.filter(isBundle).sort((a, b) => (b.pricing.basePrice || 0) - (a.pricing.basePrice || 0));
      let singles = targets.filter((o) => !isBundle(o));
      if (bundles.length) {
        ui.status(`Opening ${bundles.length} bundle${bundles.length > 1 ? 's' : ''}…`);
        await each(bundles, work);
      }

      if (!state.stopped && singles.length && !bundles.length) {
        ui.status(`Grabbing ${plural(singles.length, 'item')}…`);
        await each(singles, work);
      } else if (!state.stopped && singles.length) {
        ui.status('Checking what the bundles gave you…');
        const shop2 = await loadShop();
        const midBal = await getBalance();
        if (startBal != null && midBal != null && midBal < startBal) {
          throw new Error(`Safety stop: your V-Bucks went from ${startBal} to ${midBal}`);
        }
        const fresh = new Map(shop2.offers.map((o) => [o.offerId, o]));
        const left = [];
        for (const o of singles) {
          const f = fresh.get(o.offerId);
          if (f && owned(f)) { stats.viaBundle++; ui.tile(o.offerId, 'bundle'); }
          else if (f && !isFree(f)) { stats.failed.push({ title: o.title, why: 'no longer free' }); ui.tile(o.offerId, 'failed', 'no longer free'); }
          else left.push(o);
        }
        count();
        singles = left;
        if (singles.length && !state.stopped) {
          ui.status(`Grabbing ${singles.length} more item${singles.length > 1 ? 's' : ''}…`);
          await each(singles, work);
        }
      }

      const endBal = state.stopped ? null : await getBalance();
      state.remaining = stats.failed.length + (targets.length - (stats.claimed + stats.viaBundle + stats.owned + stats.failed.length));
      ui.done({
        ...stats, notCovered, stopped: state.stopped,
        seconds: (performance.now() - t0) / 1000,
        balance: { start: startBal, end: endBal },
      });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg === STOPPED) closeModal();
      else ui.error(msg);
    } finally {
      gate.onWait = null;
      gate.onResume = null;
      gate.blockedUntil = 0;
      state.running = false;
      state.stopped = false;
      liveShop = null;
      syncHero();
      refreshLive();
    }
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12.5 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bang: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v8" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><circle cx="12" cy="18.5" r="1.9" fill="currentColor"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="3" fill="currentColor"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 9.3a2.9 2.9 0 1 1 4.3 2.5c-.9.5-1.5 1.2-1.5 2.2v.6" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="18.6" r="1.7" fill="currentColor"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5.5c0 4.3-3 8-7 9.5-4-1.5-7-5.2-7-9.5V6z" fill="currentColor" opacity=".18"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function pageShop() {
    try {
      const d = window.__reactRouterDataRouter?.state?.loaderData?.['routes/item-shop._index'];
      return d ? { loggedIn: d.isLoggedIn !== false, offers: collectOffers(d) } : null;
    } catch (_) { return null; }
  }

  function tokenUntil() {
    const el = [...document.querySelectorAll('button, span')].find((e) => e.children.length < 3 && /^Active until/i.test((e.textContent || '').trim()));
    if (!el) return '';
    const m = el.textContent.trim().match(/^Active until\s+([A-Za-z]+\s+\d+)/i);
    return m ? m[1] : '';
  }

  function tileHTML(o) {
    const src = thumb(o);
    return src ? `<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="${esc(src)}">` : `<span class="pt-tname">${esc(o.title)}</span>`;
  }

  function countTo(el, to, dur = 450) {
    const from = +el.textContent || 0;
    if (reduceMotion || to === from) { el.textContent = to; return; }
    const t0 = performance.now();
    (function step(t) {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  let hero = null, fab = null, io = null;

  // page data goes stale after claiming, refetch it
  let liveShop = null, liveFetching = false;
  async function refreshLive() {
    if (liveFetching) return;
    liveFetching = true;
    try { liveShop = await loadShop(); state.remaining = null; } catch (_) { /* ignore */ }
    finally { liveFetching = false; if (hero) hero.dataset.key = ''; updateHero(); }
  }

  // block is 'signin' or 'notoken' when there's nothing we can claim for this account
  function heroData() {
    const shop = liveShop || pageShop();
    if (!shop) return { n: state.remaining, block: '' };
    if (!shop.loggedIn) return { n: null, block: 'signin' };
    if (!hasToken(shop.offers)) return { n: null, block: 'notoken' };
    const free = shop.offers.filter((o) => !owned(o) && isFree(o)).length;
    return { n: state.remaining != null ? Math.min(state.remaining, free) : free, block: '' };
  }

  function buildHero(nativeBtn) {
    const el = document.createElement('button');
    el.id = 'pt-hero';
    el.type = 'button';
    // use epic's button classes so it looks native
    el.className = (nativeBtn?.className || '') + ' pt-native';
    el.innerHTML = '<span class="pt-hb-logo pt-logo"></span><span class="pt-hb-label">Claim all free</span><span class="pt-hb-n"></span>';
    el.addEventListener('click', () => { if (!state.running) run(); });
    return el;
  }

  function publish(n, block) {   // for the popup
    const d = document.documentElement.dataset;
    d.ptFree = n == null ? '' : String(n);
    d.ptUntil = tokenUntil();
    d.ptRunning = state.running ? '1' : '';
    d.ptBlock = block || '';
  }

  function updateHero() {
    const { n, block } = heroData();
    publish(n, block);
    if (fab) {
      const fn = fab.querySelector('.pt-fab-n');
      fn.textContent = n ?? '';
      fn.hidden = !n;
    }
    if (!hero) return;
    const key = `${n}|${state.running}|${block}`;
    if (hero.dataset.key === key) return;
    const changed = hero.dataset.key && hero.dataset.key.split('|')[0] !== String(n);
    hero.dataset.key = key;
    const label = hero.querySelector('.pt-hb-label');
    const badge = hero.querySelector('.pt-hb-n');
    hero.classList.toggle('is-running', state.running);
    hero.classList.toggle('is-done', !state.running && n === 0);
    if (state.running) { label.textContent = 'Claiming…'; badge.hidden = true; }
    else if (n === 0) { label.textContent = 'All claimed'; badge.hidden = false; badge.innerHTML = ICON.check; }
    else { label.textContent = 'Claim all free'; badge.hidden = n == null; badge.textContent = n ?? ''; }
    hero.title = block === 'signin' ? 'Sign in to claim'
      : block === 'notoken' ? 'No Pirate Shop token on this account'
      : n ? `Claim ${plural(n, 'free item')}. Never spends V-Bucks` : n === 0 ? 'You own every free item in today’s shop' : 'Claim every free item';
    if (changed && !reduceMotion) badge.animate([{ transform: 'scale(.4)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  }

  function mountHero() {
    if (!SHOP_RE.test(location.pathname)) { hero?.remove(); setFab(false); return; }
    const h1 = [...document.querySelectorAll('h1')].find((h) => /item\s*shop/i.test(h.textContent || ''));
    const row = h1?.parentElement;
    if (!row) return;
    const buy = [...row.children].find((c) => c !== h1 && c.id !== 'pt-hero' && /v-bucks/i.test(c.textContent || ''));
    if (!hero) {
      hero = buildHero(buy);
      io = new IntersectionObserver(([e]) => setFab(!e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
    }
    if (!hero.isConnected && !state.running) refreshLive();
    if (hero.parentElement !== row || (buy && hero.nextElementSibling !== buy)) {
      row.insertBefore(hero, buy || null);
      io.disconnect(); io.observe(hero);
    }
    updateHero();
  }

  function setFab(on) {
    if (on && (state.running || !SHOP_RE.test(location.pathname) || heroData().n === 0)) on = false;
    if (on && !fab) {
      fab = document.createElement('button');
      fab.id = 'pt-fab';
      fab.type = 'button';
      fab.setAttribute('aria-label', 'Claim all free items');
      fab.innerHTML = '<span class="pt-logo"></span><span class="pt-fab-n" hidden></span><span class="pt-fab-tip">Claim all free</span>';
      fab.addEventListener('click', () => { if (!state.running) run(); });
      document.body.appendChild(fab);
      updateHero();
    }
    if (fab) requestAnimationFrame(() => fab.classList.toggle('is-on', on));
  }

  function syncHero() { hero && (hero.dataset.key = ''); mountHero(); setFab(false); }

  let root = null;

  function openModal() {
    root?.remove();
    root = document.createElement('div');
    root.id = 'pt-root';
    root.innerHTML = `
      <div class="pt-scrim"></div>
      <div class="pt-modal" role="dialog" aria-modal="true" aria-label="Claiming free items">
        <div class="pt-m-top">
          <span class="pt-blob b1"></span><span class="pt-blob b2"></span><span class="pt-blob b3"></span>
          <div class="pt-m-logo"><span class="pt-logo"></span></div>
          <div class="pt-m-count" hidden><b class="pt-n">0</b><span class="pt-total"></span></div>
          <div class="pt-m-title" hidden></div>
          <div class="pt-status" aria-live="polite">Setting sail…</div>
          <div class="pt-bar" hidden><i></i></div>
          <div class="pt-toast-row"></div>
          <div class="pt-summary"></div>
        </div>
        <div class="pt-grid" hidden></div>
        <div class="pt-m-foot">
          <button type="button" class="pt-btn pt-stop">Stop <kbd>Esc</kbd></button>
        </div>
      </div>
      <canvas class="pt-confetti"></canvas>`;
    document.body.appendChild(root);
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    root._restore = () => { document.documentElement.style.overflow = prevOverflow; };
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('is-open')));

    const $ = (s) => root.querySelector(s);
    const tiles = new Map();
    let total = 0;
    $('.pt-stop').onclick = () => { state.stopped = true; ui.status('Stopping after the current claims…'); $('.pt-stop').disabled = true; };
    $('.pt-stop').focus({ preventScroll: true });

    const ui = {
      status(text) { $('.pt-status').textContent = text; },
      build(offers) {
        total = offers.length;
        $('.pt-m-count').hidden = false;
        $('.pt-bar').hidden = false;
        $('.pt-total').textContent = `/ ${total}`;
        const grid = $('.pt-grid');
        grid.hidden = false;
        grid.innerHTML = '';
        offers.forEach((o, i) => {
          const t = document.createElement('div');
          t.className = 'pt-tile' + (isBundle(o) ? ' is-bundle' : '');
          t.style.setProperty('--c1', o.color1 || '#cfd6ff');
          t.style.setProperty('--c2', o.color2 || '#8f9cff');
          t.style.setProperty('--d', `${Math.min(i, 50) * 18}ms`);
          t.title = o.title;
          t.innerHTML = `${tileHTML(o)}<span class="pt-badge"></span>`;
          grid.appendChild(t);
          tiles.set(o.offerId, t);
        });
      },
      tile(id, status, why) {
        const t = tiles.get(id);
        if (!t) return;
        t.classList.remove('s-working');
        const s = status === 'owned' ? 'bundle' : status;
        t.classList.add('s-' + s);
        const badge = t.querySelector('.pt-badge');
        if (s === 'claimed' || s === 'bundle') badge.innerHTML = ICON.check;
        if (s === 'failed') badge.innerHTML = ICON.bang;
        if (why) t.title += `: ${why}`;
        if (s === 'working') t.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
        if (s === 'claimed' && !reduceMotion) {
          t.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }],
            { duration: 520, easing: 'cubic-bezier(.34,1.56,.64,1)' });
          sparkle(t);
        }
      },
      progress(done) {
        countTo($('.pt-n'), done);
        $('.pt-bar i').style.width = `${total ? (done / total) * 100 : 0}%`;
      },
      toast(o) {
        const row = $('.pt-toast-row');
        row.innerHTML = `<span class="pt-toast"><span class="pt-toast-img" style="--c1:${esc(o.color1 || '#ffe27a')};--c2:${esc(o.color2 || '#ffb703')}">${tileHTML(o)}</span><span class="pt-toast-t">${esc(o.title)}</span><span class="pt-toast-ok">${ICON.check}</span></span>`;
      },
      done(s) {
        root.classList.add('is-done');
        $('.pt-toast-row').innerHTML = '';
        $('.pt-bar').hidden = true;
        const got = s.claimed + s.viaBundle + s.owned;
        const secs = s.seconds < 60 ? `${s.seconds.toFixed(1)} seconds` : `${Math.floor(s.seconds / 60)} min ${Math.round(s.seconds % 60)} s`;
        const title = $('.pt-m-title');
        title.hidden = false;
        if (s.nothing) {
          $('.pt-m-count').hidden = true;
          title.textContent = 'Nothing left to claim';
          ui.status('You already own every free item in today’s shop.');
        } else {
          countTo($('.pt-n'), got, 300);
          title.textContent = s.stopped ? 'Stopped' : got ? 'All yours!' : 'Nothing claimed';
          ui.status(s.stopped
            ? `Got ${plural(got, 'item')} before stopping.`
            : `${plural(s.granted + s.viaBundle, 'cosmetic')} added to your locker in ${secs}.`);
        }
        const bal = s.balance && s.balance.start != null && s.balance.end != null
          ? (s.balance.end < s.balance.start
            ? `<span class="pt-chip pt-chip-bad">${ICON.bang} V-Bucks changed: ${s.balance.start} → ${s.balance.end}</span>`
            : `<span class="pt-chip pt-chip-ok">${ICON.shield} V-Bucks untouched · ${s.balance.end.toLocaleString()}</span>`) : '';
        const stat = (cls, n, label) => n ? `<span class="pt-chip ${cls}"><i></i><b>${n}</b> ${label}</span>` : '';
        const chips = [
          stat('pt-c-claimed', s.claimed, s.claimed === 1 ? 'claim' : 'claims'),
          stat('pt-c-bundle', s.viaBundle + s.owned, 'came with bundles'),
          stat('pt-c-failed', s.failed.length, 'skipped'),
        ].join('');
        const failed = s.failed.length
          ? `<details class="pt-more"><summary>Why ${s.failed.length === 1 ? 'one was' : `${s.failed.length} were`} skipped</summary><ul>${s.failed.map((f) => `<li><b>${esc(f.title)}</b><span>${esc(f.why)}</span></li>`).join('')}</ul></details>` : '';
        const nc = s.notCovered?.length
          ? `<details class="pt-more"><summary>${plural(s.notCovered.length, 'item')} the token doesn’t cover</summary><ul>${s.notCovered.map((o) =>
              `<li><b>${esc(o.title)}</b><span>${o.pricing?.currencyType === 'RealMoney' ? 'real-money pack' : `${(o.pricing?.finalPrice ?? 0).toLocaleString()} V-Bucks`}</span></li>`).join('')}</ul></details>` : '';
        $('.pt-summary').innerHTML = `<div class="pt-chips">${bal}${chips}</div>${failed}${nc}`;
        const foot = $('.pt-m-foot');
        const again = s.stopped || s.failed.length;
        foot.innerHTML = `${again ? '<button type="button" class="pt-btn pt-again">Try again</button>' : ''}
          <button type="button" class="pt-btn pt-primary pt-finish">Done</button>`;
        foot.querySelector('.pt-again')?.addEventListener('click', () => { closeModal(); run(); });
        foot.querySelector('.pt-finish').onclick = () => location.reload();
        foot.querySelector('.pt-finish').focus({ preventScroll: true });
        if (!s.stopped && got > 0) confetti(root.querySelector('.pt-confetti'), $('.pt-m-logo'));
      },
      error(msg) {
        root.classList.add('is-done', 'is-error');
        $('.pt-bar').hidden = true;
        $('.pt-toast-row').innerHTML = '';
        const title = $('.pt-m-title');
        title.hidden = false;
        title.textContent = 'Hit a little snag';
        ui.status(`${msg}. Nothing was charged.`);
        const foot = $('.pt-m-foot');
        foot.innerHTML = '<button type="button" class="pt-btn">Close</button><button type="button" class="pt-btn pt-primary">Try again</button>';
        foot.children[0].onclick = closeModal;
        foot.children[1].onclick = () => { closeModal(); run(); };
        foot.children[1].focus({ preventScroll: true });
      },
      notice(kind) {
        const n = kind === 'signin'
          ? { icon: ICON.lock, title: 'Sign in first', text: 'You’re not signed in on fortnite.com. Sign in with your Pirate Shop token account and try again.' }
          : { icon: ICON.ask, title: 'No token here', text: 'This account doesn’t have an active Pirate Shop Access token, so the shop still costs V-Bucks. Nothing was bought.' };
        root.classList.add('is-done', 'is-notice', `is-${kind}`);
        $('.pt-bar').hidden = true;
        $('.pt-toast-row').innerHTML = '';
        $('.pt-m-logo').insertAdjacentHTML('beforeend', `<span class="pt-m-tag">${n.icon}</span>`);
        const title = $('.pt-m-title');
        title.hidden = false;
        title.textContent = n.title;
        ui.status(n.text);
        const foot = $('.pt-m-foot');
        foot.innerHTML = kind === 'signin'
          ? '<button type="button" class="pt-btn">Close</button><button type="button" class="pt-btn pt-primary">Sign in</button>'
          : '<button type="button" class="pt-btn pt-primary">Got it</button>';
        foot.firstElementChild.onclick = closeModal;
        if (kind === 'signin') foot.lastElementChild.onclick = signIn;
        foot.lastElementChild.focus({ preventScroll: true });
      },
    };
    return ui;
  }

  // epic's own sign in link lives inside their nav's shadow dom
  function signIn() {
    const a = document.querySelector('fortnite-navigation')?.shadowRoot?.querySelector('a[href*="/login"]');
    if (a) a.click(); else location.href = '/item-shop/login';
  }

  function closeModal() {
    if (!root) return;
    const r = root; root = null;
    r._restore?.();
    r.classList.remove('is-open');
    setTimeout(() => r.remove(), 300);
    syncHero();
  }

  function sparkle(tile) {
    const colors = ['#ffd23f', '#ff8fb1', '#7cd4ff', '#8ef0b4'];
    for (let i = 0; i < 7; i++) {
      const s = document.createElement('i');
      s.className = 'pt-spark';
      const a = (i / 7) * Math.PI * 2 + Math.random() * .5;
      const d = 26 + Math.random() * 16;
      s.style.cssText = `--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d}px;background:${colors[i % colors.length]}`;
      tile.appendChild(s);
      setTimeout(() => s.remove(), 700);
    }
  }

  function confetti(canvas, fromEl) {
    if (reduceMotion || !canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = canvas.width = innerWidth * dpr, H = canvas.height = innerHeight * dpr;
    const rc = fromEl?.getBoundingClientRect();
    const ox = rc ? (rc.left + rc.width / 2) * dpr : W / 2, oy = rc ? (rc.top + rc.height / 2) * dpr : H / 3;
    const colors = ['#ffd23f', '#ffb703', '#ff8fb1', '#7cd4ff', '#8ef0b4', '#c7a6ff'];
    const parts = Array.from({ length: 140 }, (_, i) => {
      const a = Math.random() * Math.PI * 2, sp = (Math.random() * 14 + 6) * dpr;
      return { x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 8 * dpr, r: (Math.random() * 5 + 3.5) * dpr,
        rot: Math.random() * 6, vr: (Math.random() - .5) * .3, kind: i % 5 === 0 ? 'coin' : i % 3 === 0 ? 'ring' : 'dot', c: colors[i % colors.length] };
    });
    const t0 = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, W, H);
      const life = (t - t0) / 2600;
      for (const p of parts) {
        p.vy += .38 * dpr; p.vx *= .985; p.vy *= .985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.globalAlpha = Math.max(0, 1 - life * life);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        if (p.kind === 'coin') {
          ctx.scale(Math.abs(Math.cos(p.rot * 2)) * .85 + .15, 1);
          ctx.fillStyle = '#ffcf2e'; ctx.beginPath(); ctx.arc(0, 0, p.r * 1.3, 0, 7); ctx.fill();
          ctx.fillStyle = '#ffe680'; ctx.beginPath(); ctx.arc(0, 0, p.r * .7, 0, 7); ctx.fill();
        } else if (p.kind === 'ring') {
          ctx.strokeStyle = p.c; ctx.lineWidth = 2.2 * dpr; ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 7); ctx.stroke();
        } else {
          ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 7); ctx.fill();
        }
        ctx.restore();
      }
      if (life < 1) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
    })(t0);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !root) return;
    e.stopPropagation();
    if (state.running) root.querySelector('.pt-stop')?.click();
    else if (root.classList.contains('is-done')) closeModal();
  }, true);

  // from the popup
  document.addEventListener('pt:claim', () => { if (!state.running) run(); });

  // popup opens the shop with ?ptclaim=1
  (async () => {
    const url = new URL(location.href);
    if (!url.searchParams.has('ptclaim')) return;
    url.searchParams.delete('ptclaim');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    for (let i = 0; i < 40 && !window.__reactRouterDataRouter; i++) await sleep(250);
    await sleep(900);   // page needs a sec
    if (!state.running) run();
  })();

  mountHero();
  setInterval(mountHero, 800);   // react keeps removing the button
})();
