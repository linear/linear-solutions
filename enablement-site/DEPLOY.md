# Deploy: private GitHub repo → access-code-gated site on Vercel

This `site/` folder is the complete website. It contains:

- `index.html` — the guide (served at the root URL)
- `media/` — images and the recording
- `middleware.js` — gates the whole site behind a shared access code (Edge Middleware)
- `package.json`, `.gitignore`

The access code is **not** in the code. It lives in an environment variable called `ACCESS_CODE`, which you set in Vercel. Change the code anytime by changing that variable.

---

## 1 · Create a private GitHub repo and push

From inside this `site/` folder in a terminal:

```bash
git init
git add .
git commit -m "Linear enablement guide"
git branch -M main
```

Create the empty **private** repo (pick one):

- **GitHub CLI:** `gh repo create linear-enablement-guide --private --source=. --remote=origin --push`
- **Or on github.com:** New → Repository → name it, set **Private**, **don't** add a README, Create. Then:

```bash
git remote add origin https://github.com/<your-username>/linear-enablement-guide.git
git push -u origin main
```

## 2 · Import into Vercel

1. Go to **vercel.com/new** and sign in with GitHub.
2. **Import** the `linear-enablement-guide` repo (authorize Vercel for the private repo if asked).
3. Framework Preset: **Other**. Leave Build & Output settings empty (it's static).
4. Expand **Environment Variables** and add:
   - **Name:** `ACCESS_CODE`
   - **Value:** the code you want to hand out (e.g. `your-access-code`)
5. Click **Deploy**.

## 3 · Verify

- Open the deployment URL → you should see the **"Enter the access code"** page.
- Enter the code → the guide loads. The unlock is remembered for 30 days (cookie).
- Wrong code → it re-prompts.

## Updating later

Any push to `main` redeploys automatically. To update content, replace `index.html`
(and/or files in `media/`), then:

```bash
git add . && git commit -m "Update guide" && git push
```

## Changing or rotating the access code

Vercel → your project → **Settings → Environment Variables** → edit `ACCESS_CODE` →
then **Redeploy** (Deployments tab → ⋯ → Redeploy). Everyone must re-enter the new code.

## Notes

- This Edge Middleware gate works on Vercel's **free Hobby plan**.
- It protects **every** file, including images — nothing is reachable without the code.
- Vercel also offers built-in **Password Protection** (Settings → Deployment Protection),
  but that's a paid (Pro) feature. The middleware here does the same job for free.
- The gate is a single shared code, suitable for limiting casual access. For per-user
  accounts or audit logs, use Vercel's paid protection or an auth provider.
