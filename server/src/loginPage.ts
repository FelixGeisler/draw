// The login page for the password gate (#190, ADR-50): server-rendered,
// self-contained HTML — the React client stays untouched (its bundle is
// byte-identical with auth off), and the gate can serve this before any
// static asset is accessible. Palette mirrors client/src/index.css.

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draw — unlock</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #12141a; color: #e8eaf0;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    width: min(320px, 90vw); padding: 2rem 1.75rem; border-radius: 12px;
    background: #1b1e27; border: 1px solid #2c3040; text-align: center;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.35rem; }
  p.hint { color: #9aa0b0; font-size: 0.85rem; margin-bottom: 1.25rem; }
  label { display: block; text-align: left; font-size: 0.85rem; color: #9aa0b0; margin-bottom: 0.35rem; }
  input {
    width: 100%; padding: 0.55rem 0.7rem; border-radius: 8px;
    background: #12141a; color: #e8eaf0; border: 1px solid #2c3040; font-size: 1rem;
  }
  input:focus { outline: 2px solid #4f8cff; outline-offset: -1px; }
  button {
    width: 100%; margin-top: 0.85rem; padding: 0.55rem; border-radius: 8px;
    background: #4f8cff; color: #fff; border: 1px solid #4f8cff;
    font-size: 1rem; cursor: pointer;
  }
  button:hover { filter: brightness(1.1); }
  #error { color: #ff6b6b; font-size: 0.85rem; min-height: 1.2em; margin-top: 0.75rem; }
</style>
</head>
<body>
<main>
  <h1>🃏 Draw</h1>
  <p class="hint">This instance is password protected.</p>
  <form id="login-form">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <button type="submit">Unlock</button>
  </form>
  <p id="error" role="alert"></p>
</main>
<script>
  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.getElementById("error");
    error.textContent = "";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: document.getElementById("password").value }),
      });
      if (res.status === 204) { location.reload(); return; }
      const body = await res.json().catch(() => null);
      error.textContent = (body && body.error) || "Login failed";
    } catch {
      error.textContent = "Network error — try again";
    }
  });
</script>
</body>
</html>
`;

export function renderLoginPage(): string {
  return PAGE;
}
