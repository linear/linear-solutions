// Vercel Edge Middleware — gates the entire site behind a shared access code.
// The code lives in the ACCESS_CODE environment variable (set in Vercel project settings),
// never in this source. Runs on Vercel's free (Hobby) plan.

const COOKIE = "guide_access";

export const config = {
  // Run on every request except Vercel's internal assets.
  matcher: "/((?!_vercel/).*)",
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const code = process.env.ACCESS_CODE || "";
  const token = btoa("granted:" + code);

  // 1) Handle the access-code form submission.
  if (request.method === "POST" && url.pathname === "/__access") {
    const form = await request.formData();
    const entered = String(form.get("code") || "");
    if (code && entered === code) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        },
      });
    }
    return page(true);
  }

  // 2) Already unlocked (valid cookie)? Let the request through.
  const cookie = request.headers.get("cookie") || "";
  if (token && cookie.split(";").some((c) => c.trim() === `${COOKIE}=${token}`)) {
    return; // continue to the static file
  }

  // 3) Otherwise show the access-code page.
  return page(false);
}

function page(error) {
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access · Linear Enablement Guide</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F4F5F8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif;color:#222326}
  .card{width:340px;max-width:90vw;background:#fff;border:1px solid #E3E5EC;border-radius:16px;padding:32px 28px;box-shadow:0 16px 44px rgba(94,106,210,.12);text-align:center}
  .logo{width:34px;height:34px;color:#5E6AD2;margin:0 auto 14px}
  .logo svg{width:100%;height:100%;display:block}
  h1{font-size:18px;margin:0 0 4px;letter-spacing:-.3px}
  p{font-size:13px;color:#6A6E78;margin:0 0 20px}
  input{width:100%;padding:11px 13px;border:1px solid #E3E5EC;border-radius:9px;font-size:15px;outline:none;text-align:center;letter-spacing:1px;box-sizing:border-box}
  input:focus{border-color:#5E6AD2}
  button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;background:#5E6AD2;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:#4E5FB0}
  .err{color:#C0392B;font-size:12.5px;margin-top:10px;display:${error ? "block" : "none"}}
</style></head>
<body>
  <form class="card" method="POST" action="/__access">
    <div class="logo"><svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.629 0 24 5.372 24 11.991c0 3.704-1.678 7.017-4.318 9.218L2.886 4.18ZM1.058 6.513a11.945 11.945 0 0 0-.71 1.728l14.823 14.824a11.97 11.97 0 0 0 1.728-.71L1.058 6.513ZM.166 10.071a12.05 12.05 0 0 0-.16 1.984L11.945 23.994c.674-.005 1.338-.06 1.984-.16L.166 10.072ZM.005 13.793A12 12 0 0 0 10.207 23.995L.005 13.793Z"/></svg></div>
    <h1>Linear Enablement Guide</h1>
    <p>Enter the access code to continue.</p>
    <input name="code" type="password" autofocus autocomplete="off" placeholder="Access code" />
    <button type="submit">Unlock</button>
    <div class="err">Incorrect code — try again.</div>
  </form>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
