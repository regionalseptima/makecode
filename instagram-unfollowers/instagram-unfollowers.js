/*
 * Instagram: quién no me sigue de vuelta
 *
 * Uso: abre https://www.instagram.com con tu sesión iniciada, abre la consola
 * del navegador (F12 -> "Consola"), pega este archivo completo y pulsa Enter.
 *
 * Todo ocurre dentro de tu navegador, con tu propia sesión. El script no pide
 * tu contraseña ni envía datos a ningún sitio que no sea instagram.com.
 */
(async () => {
  'use strict';

  const APP_ID = '936619743392459'; // identificadores públicos de la web de Instagram
  const ASBD_ID = '359341';
  const FOLLOWING_QUERY_HASH = '3dec7e2c57367ef3da3d987d89f9dbc8';
  const PANEL_ID = 'ig-nofollowback-panel';
  const UNFOLLOW_GAP_MS = 1500; // espera mínima entre dos "dejar de seguir"

  if (!/(^|\.)instagram\.com$/.test(location.hostname)) {
    alert('Abre primero https://www.instagram.com y ejecuta el script allí.');
    return;
  }

  const cookie = (name) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };
  const myId = cookie('ds_user_id');
  if (!myId) {
    alert('No hay sesión iniciada en Instagram. Inicia sesión y vuelve a ejecutar el script.');
    return;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base) => base + Math.floor(Math.random() * base * 0.5);

  class RateLimitError extends Error {}
  // Instagram ha bloqueado la acción o pide verificar la cuenta: no tiene
  // sentido reintentar por otra vía.
  class BlockedError extends Error {}

  const storage = (key) => {
    try {
      return sessionStorage.getItem(key) || localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  };

  // Cabeceras que envía la propia web de Instagram en sus llamadas /api/v1.
  const webSessionId = [0, 0, 0]
    .map(() => Math.random().toString(36).slice(2, 8).padEnd(6, '0'))
    .join(':');
  let wwwClaim = storage('www-claim-v2') || '0';

  function igHeaders(extra = {}) {
    return {
      'X-IG-App-ID': APP_ID,
      'X-ASBD-ID': ASBD_ID,
      'X-IG-WWW-Claim': wwwClaim,
      'X-Web-Session-ID': webSessionId,
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRFToken': cookie('csrftoken') || '',
      Accept: '*/*',
      ...extra,
    };
  }

  // Devuelve { res, json, text }; json es null si la respuesta no es JSON
  // (Instagram contesta a rutas desconocidas con una página HTML y HTTP 200).
  async function request(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: igHeaders(options.headers),
    });
    const claim = res.headers.get('x-ig-set-www-claim');
    if (claim) wwwClaim = claim;
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text.replace(/^for \(;;\);/, ''));
    } catch (e) {
      // no es JSON
    }
    return { res, json, text };
  }

  function describeFailure({ res, json, text }) {
    if (json) {
      const reason = json.message || json.error_type || json.feedback_message || json.errorSummary;
      return 'HTTP ' + res.status + ': ' + (reason || JSON.stringify(json).slice(0, 200));
    }
    return 'HTTP ' + res.status + ', respuesta no válida (' + (res.headers.get('content-type') || 'sin tipo') + ')';
  }

  function throwIfBlocked(r) {
    if (r.res.status === 429) throw new RateLimitError('Instagram pide esperar (límite de peticiones).');
    const j = r.json || {};
    const reason = [j.message, j.error_type, j.feedback_message, j.errorSummary].join(' ');
    if (
      j.spam === true ||
      /feedback_required|checkpoint|challenge_required|login_required|action_blocked|try again later/i.test(reason)
    ) {
      throw new BlockedError(describeFailure(r));
    }
  }

  async function api(path, options = {}) {
    const r = await request(path, options);
    throwIfBlocked(r);
    if (!r.res.ok || !r.json) throw new Error(describeFailure(r));
    return r.json;
  }

  // ---------- Obtención de datos ----------

  let cancelled = false;

  // Pausa entre páginas para no disparar los límites de Instagram.
  async function pace(page) {
    await sleep(page % 6 === 0 ? jitter(8000) : jitter(1000));
  }

  // Método principal: la lista de seguidos ya indica si cada uno te sigue.
  async function scanGraphql(onProgress) {
    const result = [];
    let after = null;
    let page = 0;
    for (;;) {
      if (cancelled) return null;
      const variables = { id: myId, include_reel: false, fetch_mutual: false, first: 50 };
      if (after) variables.after = after;
      const json = await api(
        '/graphql/query/?query_hash=' + FOLLOWING_QUERY_HASH +
          '&variables=' + encodeURIComponent(JSON.stringify(variables))
      );
      const edge = json && json.data && json.data.user && json.data.user.edge_follow;
      if (!edge) throw new Error('Respuesta inesperada de Instagram');
      for (const { node } of edge.edges) {
        if (typeof node.follows_viewer !== 'boolean') throw new Error('Falta follows_viewer');
        result.push({
          id: node.id,
          username: node.username,
          fullName: node.full_name || '',
          pic: node.profile_pic_url,
          verified: !!node.is_verified,
          followsMe: node.follows_viewer,
        });
      }
      onProgress('Leyendo seguidos… ' + result.length + ' de ' + edge.count);
      // Instagram a veces devuelve el total correcto pero la lista vacía.
      if (edge.edges.length === 0 && result.length < edge.count) throw new Error('Lista de seguidos vacía');
      if (!edge.page_info.has_next_page) break;
      after = edge.page_info.end_cursor;
      await pace(++page);
    }
    return result;
  }

  // Método alternativo: descargar seguidos y seguidores y comparar.
  async function fetchList(kind, label, onProgress) {
    const users = [];
    let maxId = null;
    let page = 0;
    for (;;) {
      if (cancelled) return null;
      const json = await api(
        '/api/v1/friendships/' + myId + '/' + kind + '/?count=100' +
          (maxId ? '&max_id=' + encodeURIComponent(maxId) : '')
      );
      if (!json || !Array.isArray(json.users)) throw new Error('Respuesta inesperada de Instagram');
      users.push(...json.users);
      onProgress('Leyendo ' + label + '… ' + users.length);
      if (!json.next_max_id) break;
      maxId = json.next_max_id;
      await pace(++page);
    }
    return users;
  }

  async function scanRest(onProgress) {
    const following = await fetchList('following', 'seguidos', onProgress);
    if (!following) return null;
    const followers = await fetchList('followers', 'seguidores', onProgress);
    if (!followers) return null;
    const followerIds = new Set(followers.map((u) => String(u.pk)));
    return following.map((u) => ({
      id: String(u.pk),
      username: u.username,
      fullName: u.full_name || '',
      pic: u.profile_pic_url,
      verified: !!u.is_verified,
      followsMe: followerIds.has(String(u.pk)),
    }));
  }

  // Tokens de sesión (fb_dtsg) que la web de Instagram adjunta a sus acciones.
  let sessionTokens = null;
  function tokensFromHtml(html) {
    const m =
      /"DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html) || /"dtsg":\{"token":"([^"]+)"/.exec(html);
    if (!m) return null;
    const rev = /"client_revision":(\d+)/.exec(html);
    return { fbDtsg: m[1], revision: rev ? rev[1] : '' };
  }
  async function getSessionTokens() {
    if (sessionTokens) return sessionTokens;
    try {
      if (typeof window.require === 'function') {
        const fbDtsg = (window.require('DTSGInitialData') || {}).token;
        if (fbDtsg) {
          const site = window.require('SiteData') || {};
          sessionTokens = { fbDtsg, revision: site.client_revision ? String(site.client_revision) : '' };
          return sessionTokens;
        }
      }
    } catch (e) {
      // registro de módulos no disponible: se busca en el HTML
    }
    sessionTokens = tokensFromHtml(document.documentElement.innerHTML);
    if (!sessionTokens) {
      try {
        const res = await fetch('/', { credentials: 'same-origin' });
        sessionTokens = tokensFromHtml(await res.text());
      } catch (e) {
        // se informa abajo
      }
    }
    return sessionTokens;
  }

  // Suma de comprobación que Instagram envía junto a fb_dtsg.
  function jazoest(fbDtsg) {
    let sum = 0;
    for (let i = 0; i < fbDtsg.length; i++) sum += fbDtsg.charCodeAt(i);
    return '2' + sum;
  }

  function findFriendshipStatus(node) {
    if (node === null || typeof node !== 'object') return undefined;
    if (node.friendship_status && typeof node.friendship_status === 'object') return node.friendship_status;
    for (const value of Object.values(node)) {
      const found = findFriendshipStatus(value);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // Busca la cuenta en tu lista de seguidos. Devuelve null si no se pudo comprobar.
  async function isStillFollowing(user) {
    try {
      const json = await api(
        '/api/v1/friendships/' + myId + '/following/?count=12&query=' +
          encodeURIComponent(user.username) + '&search_surface=follow_list_page'
      );
      if (!Array.isArray(json.users)) return null;
      return json.users.some((u) => String(u.pk) === user.id || u.username === user.username);
    } catch (e) {
      return null;
    }
  }

  // Deja de seguir igual que el botón de la web y solo lo da por hecho cuando
  // Instagram confirma que ya no sigues a la cuenta: un HTTP 200 no basta.
  async function unfollow(user) {
    const tokens = await getSessionTokens();
    if (!tokens) throw new Error('no se encontró el token de sesión; recarga la página y vuelve a pegar el script');
    const body = new URLSearchParams({
      container_module: 'profile',
      nav_chain: 'PolarisProfilePostsTabRoot:profilePage:1:via_cold_start',
      user_id: user.id,
      jazoest: jazoest(tokens.fbDtsg),
      fb_dtsg: tokens.fbDtsg,
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (tokens.revision) headers['X-Instagram-AJAX'] = tokens.revision;

    const r = await request('/api/v1/friendships/destroy/' + user.id + '/', {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    throwIfBlocked(r);
    if (!r.res.ok || !r.json || r.json.status !== 'ok') throw new Error(describeFailure(r));

    const fs = findFriendshipStatus(r.json);
    if (fs && fs.following === false && !fs.outgoing_request) return;
    if (fs && (fs.following === true || fs.outgoing_request === true)) {
      throw new Error('Instagram respondió pero sigues siguiendo a la cuenta');
    }
    const still = await isStillFollowing(user);
    if (still === true) throw new Error('Instagram respondió pero la cuenta sigue en tu lista de seguidos');
    if (still === null) throw new Error('no se pudo confirmar; mira el perfil antes de reintentar');
  }

  // Los "dejar de seguir" se ejecutan de uno en uno y espaciados.
  let unfollowChain = Promise.resolve();
  function queueUnfollow(user) {
    const run = unfollowChain.then(() => unfollow(user));
    unfollowChain = run.then(
      () => sleep(UNFOLLOW_GAP_MS),
      () => sleep(UNFOLLOW_GAP_MS)
    );
    return run;
  }

  // ---------- Interfaz ----------
  // Se construye con nodos DOM y textContent (nunca innerHTML): los nombres de
  // usuario son texto ajeno y no deben poder inyectar HTML.

  function el(tag, css, text) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text != null) node.textContent = text;
    return node;
  }

  const previous = document.getElementById(PANEL_ID);
  if (previous) previous.remove();

  const FONT = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;';
  const BTN =
    FONT + 'border:0;border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;';

  const panel = el(
    'div',
    FONT +
      'position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);z-index:2147483647;' +
      'background:#fff;color:#111;box-shadow:-4px 0 24px rgba(0,0,0,.25);display:flex;' +
      'flex-direction:column;font-size:14px;line-height:1.35;box-sizing:border-box;'
  );
  panel.id = PANEL_ID;

  const header = el('div', 'padding:14px 16px 10px;border-bottom:1px solid #e5e5e5;');
  const titleRow = el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;');
  titleRow.append(el('div', 'font-size:16px;font-weight:700;', 'No te siguen de vuelta'));
  const closeBtn = el('button', BTN + 'background:#efefef;color:#111;', 'Cerrar');
  closeBtn.type = 'button';
  titleRow.append(closeBtn);
  const status = el('div', 'margin-top:6px;color:#555;font-size:13px;', 'Preparando…');
  status.setAttribute('role', 'status');
  const notice = el(
    'div',
    'display:none;margin-top:8px;padding:8px 10px;border-radius:8px;background:#fff4d6;color:#5c4400;font-size:12.5px;'
  );
  const search = el(
    'input',
    FONT +
      'display:none;margin-top:10px;width:100%;box-sizing:border-box;padding:8px 10px;' +
      'border:1px solid #ccc;border-radius:8px;font-size:14px;background:#fff;color:#111;'
  );
  search.type = 'search';
  search.placeholder = 'Buscar por usuario o nombre';
  search.setAttribute('aria-label', 'Buscar por usuario o nombre');
  header.append(titleRow, status, notice, search);

  const list = el('div', 'flex:1;overflow-y:auto;overscroll-behavior:contain;');
  panel.append(header, list);
  document.body.append(panel);

  closeBtn.addEventListener('click', () => {
    cancelled = true;
    panel.remove();
  });

  const setStatus = (text) => {
    status.textContent = text;
  };
  const showNotice = (text) => {
    notice.textContent = text;
    notice.style.display = 'block';
  };

  let pending = 0; // cuentas listadas que aún sigues
  let total = 0;
  const updateSummary = () => {
    setStatus(
      pending === 0
        ? 'Sigues a ' + total + ' cuentas y ninguna queda pendiente en esta lista.'
        : 'Sigues a ' + total + ' cuentas; ' + pending + ' no te siguen de vuelta.'
    );
  };

  function buildRow(user) {
    const row = el('div', 'display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #f0f0f0;');
    row.dataset.search = (user.username + ' ' + user.fullName).toLowerCase();

    const img = el('img', 'width:44px;height:44px;border-radius:50%;flex:none;background:#eee;object-fit:cover;');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    if (user.pic) img.src = user.pic;

    const info = el('div', 'flex:1;min-width:0;');
    const link = el(
      'a',
      'display:block;color:#111;font-weight:600;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      '@' + user.username + (user.verified ? ' ✓' : '')
    );
    link.href = 'https://www.instagram.com/' + encodeURIComponent(user.username) + '/';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    info.append(link);
    if (user.fullName) {
      info.append(
        el('div', 'color:#666;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', user.fullName)
      );
    }
    const error = el('div', 'display:none;color:#b00020;font-size:12px;margin-top:2px;');
    info.append(error);

    const btn = el('button', BTN + 'flex:none;background:#0095f6;color:#fff;', 'Dejar de seguir');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Un momento…';
      btn.style.opacity = '.6';
      btn.style.cursor = 'default';
      error.style.display = 'none';
      try {
        await queueUnfollow(user);
        btn.textContent = 'Ya no lo sigues';
        btn.style.background = '#efefef';
        btn.style.color = '#555';
        btn.style.opacity = '1';
        row.style.background = '#fafafa';
        pending -= 1;
        updateSummary();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Reintentar';
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        console.error('[no-follow-back] No se pudo dejar de seguir a @' + user.username + ':', err);
        error.textContent =
          err instanceof RateLimitError
            ? 'Instagram pide ir más despacio. Espera unos minutos y reintenta.'
            : err instanceof BlockedError
            ? 'Instagram ha bloqueado esta acción en tu cuenta por ahora (' + err.message +
              '). Prueba a dejar de seguir a alguien a mano: si tampoco deja, toca esperar unas horas.'
            : 'No se pudo dejar de seguir (' + err.message + ').';
        error.style.display = 'block';
      }
    });

    row.append(img, info, btn);
    return row;
  }

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const row of list.children) {
      if (row.dataset.search === undefined) continue;
      row.style.display = !q || row.dataset.search.includes(q) ? 'flex' : 'none';
    }
  });

  // ---------- Ejecución ----------

  let users;
  try {
    try {
      users = await scanGraphql(setStatus);
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof BlockedError) throw err;
      console.warn('[no-follow-back] Método principal falló, probando el alternativo:', err);
      users = await scanRest(setStatus);
      if (users) {
        showNotice(
          'Se usó el método alternativo (comparar listas). Instagram a veces devuelve la lista de ' +
            'seguidores incompleta: abre el perfil y compruébalo antes de dejar de seguir a alguien.'
        );
      }
    }
  } catch (err) {
    console.error('[no-follow-back]', err);
    setStatus(
      err instanceof RateLimitError
        ? 'Instagram ha limitado las peticiones. Espera 15–30 minutos y vuelve a ejecutar el script.'
        : 'No se pudieron leer tus listas (' + err.message + '). Puede que Instagram haya cambiado su web.'
    );
    return;
  }
  if (!users) return; // cerrado por el usuario durante la lectura

  const notFollowingBack = users
    .filter((u) => !u.followsMe)
    .sort((a, b) => a.username.localeCompare(b.username));

  total = users.length;
  pending = notFollowingBack.length;
  updateSummary();

  if (notFollowingBack.length === 0) {
    list.append(el('div', 'padding:24px 16px;color:#555;', 'Todas las cuentas que sigues te siguen también.'));
    return;
  }

  search.style.display = 'block';
  const fragment = document.createDocumentFragment();
  for (const user of notFollowingBack) fragment.append(buildRow(user));
  list.append(fragment);
})();
