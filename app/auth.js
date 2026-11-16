/* Login: sends you to the sign-in page if your session runs out while the planner is open,
   and shows "Sign out" under More when login is on. */
(() => {
  const realFetch = window.fetch.bind(window);
  let leaving = false;
  window.fetch = async (...args) => {
    const r = await realFetch(...args);
    if (r.status === 401 && !leaving) {
      const u = new URL(r.url || String(args[0]), location.href);
      if (u.origin === location.origin && !u.pathname.startsWith('/api/auth/')) {
        leaving = true;
        location.href = '/login.html' + location.hash;
      }
    }
    return r;
  };
  realFetch('/api/auth/status').then((r) => r.json()).then((s) => {
    const box = document.getElementById('signout');
    if (box && s.enabled) box.hidden = false;
  }).catch(() => {});
})();
