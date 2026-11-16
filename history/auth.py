"""Login for the whole app.

nginx asks /api/auth/check before every request (auth_request). A session is a signed cookie:
"<expiry>.<hmac>", keyed by a random secret kept in data/auth-secret plus the password, so
sessions survive restarts and changing the password signs everyone out.

  CP_USERNAME   login name (default "dan")
  CP_PASSWORD   password. Empty = no login (fine on a home network, not on the internet).
  CP_SESSION_DAYS  how long "keep me signed in" lasts (default 90)
"""
import hashlib
import hmac
import os
import secrets
import threading
import time
import urllib.parse

USERNAME = os.environ.get("CP_USERNAME", "dan").strip()
PASSWORD = os.environ.get("CP_PASSWORD", "")
SESSION_DAYS = float(os.environ.get("CP_SESSION_DAYS", "90"))
SHORT_HOURS = 12  # "keep me signed in" unticked: a browser-session cookie, good for 12 h at most
COOKIE = "cp_session"
SECRET_FILE = os.path.join(os.environ.get("DATA_DIR", "/data"), "auth-secret")

MAX_FAILS = 8          # wrong passwords from one address...
FAIL_WINDOW = 15 * 60  # ...within this many seconds locks that address out until they age off
_fails = {}
_lock = threading.Lock()


def enabled():
    return bool(PASSWORD)


def _secret():
    try:
        with open(SECRET_FILE, "rb") as f:
            s = f.read().strip()
        if len(s) >= 32:
            return s
    except OSError:
        pass
    s = secrets.token_hex(32).encode()
    os.makedirs(os.path.dirname(SECRET_FILE), exist_ok=True)
    tmp = SECRET_FILE + ".tmp"
    with open(tmp, "wb") as f:
        f.write(s)
    os.chmod(tmp, 0o600)
    os.replace(tmp, SECRET_FILE)
    return s


_key = None


def _sign(expiry):
    global _key
    if _key is None:
        _key = hashlib.sha256(_secret() + b"\0" + USERNAME.encode() + b"\0" + PASSWORD.encode()).digest()
    return hmac.new(_key, str(expiry).encode(), hashlib.sha256).hexdigest()


def make_session(remember):
    expiry = int(time.time() + (SESSION_DAYS * 86400 if remember else SHORT_HOURS * 3600))
    return f"{expiry}.{_sign(expiry)}", expiry


def valid_session(cookie_header):
    if not enabled():
        return True
    token = _cookie(cookie_header)
    if not token or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(int(exp)))


def _cookie(header):
    for part in (header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE:
            return v
    return None


def locked_out(addr):
    now = time.time()
    with _lock:
        recent = [t for t in _fails.get(addr, []) if now - t < FAIL_WINDOW]
        _fails[addr] = recent
        if not recent:
            _fails.pop(addr, None)
        return len(recent) >= MAX_FAILS


def check_password(addr, user, password):
    ok = hmac.compare_digest(user.strip().lower().encode(), USERNAME.lower().encode()) & \
        hmac.compare_digest(password.encode(), PASSWORD.encode())
    if not ok:
        with _lock:
            _fails.setdefault(addr, []).append(time.time())
        time.sleep(1)  # slows guessing; the server is threaded so nobody else waits
    else:
        with _lock:
            _fails.pop(addr, None)
    return ok


def safe_next(target):
    """Only send people back to a page on this site."""
    target = target or "/"
    if not target.startswith("/") or target.startswith("//") or "\\" in target or target.startswith("/api/"):
        return "/"
    return target


def cookie_header(value, max_age, secure):
    parts = [f"{COOKIE}={value}", "Path=/", "HttpOnly", "SameSite=Lax"]
    if max_age is not None:
        parts.append(f"Max-Age={max_age}")
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def handle(h, method, path):
    """Serve /api/auth/*. Returns True if it handled the request."""
    secure = h.headers.get("X-Forwarded-Proto", "").lower() == "https"
    if path == "/api/auth/check":
        if valid_session(h.headers.get("Cookie")):
            h.send(200, b"")
        else:
            h.send(401, b'{"error":"login needed"}')
        return True
    if path == "/api/auth/status" and method == "GET":
        body = b'{"enabled":%s,"signed_in":%s}' % (
            b"true" if enabled() else b"false",
            b"true" if valid_session(h.headers.get("Cookie")) else b"false")
        h.send(200, body)
        return True
    if path == "/api/auth/login" and method == "POST":
        n = int(h.headers.get("Content-Length") or 0)
        form = urllib.parse.parse_qs(h.rfile.read(min(n, 10_000)).decode(errors="replace"))
        get = lambda k: (form.get(k) or [""])[0]
        nxt = safe_next(get("next"))
        addr = h.headers.get("X-Real-IP") or h.client_address[0]
        if not enabled():
            _redirect(h, nxt)
            return True
        if locked_out(addr):
            _redirect(h, "/login.html?error=locked&next=" + urllib.parse.quote(nxt))
            return True
        if not check_password(addr, get("username"), get("password")):
            print(f"Failed login from {addr}", flush=True)
            _redirect(h, "/login.html?error=wrong&next=" + urllib.parse.quote(nxt))
            return True
        remember = get("remember") == "on"
        value, expiry = make_session(remember)
        _redirect(h, nxt, cookie_header(value, int(expiry - time.time()) if remember else None, secure))
        return True
    if path == "/api/auth/logout" and method == "POST":
        _redirect(h, "/login.html?out=1", cookie_header("", 0, secure))
        return True
    return False


def _redirect(h, location, set_cookie=None):
    h.send_response(303)
    h.send_header("Location", location)
    if set_cookie:
        h.send_header("Set-Cookie", set_cookie)
    h.send_header("Content-Length", "0")
    h.send_header("Cache-Control", "no-store")
    h.end_headers()
