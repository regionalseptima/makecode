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

  const APP_ID = '936619743392459'; // identificador público de la web de Instagram
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

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      ...options,
      headers: {
        'X-IG-App-ID': APP_ID,
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': cookie('csrftoken') || '',
        ...(options.headers || {}),
      },
    });
    if (res.status === 429) throw new RateLimitError('Instagram pide esperar (límite de peticiones).');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
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

  async function unfollow(userId) {
    const post = (path) =>
      api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
    let json;
    try {
      json = await post('/api/v1/friendships/destroy/' + userId + '/');
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      json = await post('/web/friendships/' + userId + '/unfollow/');
    }
    if (!json || json.status !== 'ok') throw new Error('Instagram rechazó la acción');
  }

  // Los "dejar de seguir" se ejecutan de uno en uno y espaciados.
  let unfollowChain = Promise.resolve();
  function queueUnfollow(userId) {
    const run = unfollowChain.then(() => unfollow(userId));
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
        await queueUnfollow(user.id);
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
        error.textContent =
          err instanceof RateLimitError
            ? 'Instagram pide ir más despacio. Espera unos minutos y reintenta.'
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
      if (err instanceof RateLimitError) throw err;
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
