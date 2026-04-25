# Landing page — `jpogah.github.io/fork-and-go`

Static one-page landing site for Fork-and-Go. Served via GitHub Pages from `main:/docs` — the `/docs` path is used rather than `/site` because GitHub Pages' built-in source selector only accepts `/` or `/docs`. The rest of the `/docs` tree (harness-engineering notes, prompts, product specs, workflows) coexists here but is not linked from the landing page.

## Files

- **`index.html`** — the page. Plain HTML + Tailwind CDN, no build step.
- **`.nojekyll`** — disables Jekyll so Pages serves the HTML verbatim (and leaves the other `/docs` markdown content untouched).
- **`images/book-cover.png`** — hero cover used in the book section and Open Graph preview.
- **`SITE-README.md`** — this file.

## Editing

Edit `index.html`, commit via PR (branch protection requires it), merge — Pages redeploys on push to `main`. Typical deploy latency is under a minute.

The page has seven sections: hero, problem framing, loop diagram, shipped capabilities, quickstart, case study (Scrawl), and the book. Aesthetic matches the book cover and Scrawl's product palette: warm cream paper `#f6efe1`, ink-black type `#1f1a17`, teal accent `#2f6b72`, hand-drawn irregular corner radii on panels and buttons.

## Deploy (one-time setup)

GitHub Pages must be configured once to serve from this folder:

1. Repo **Settings → Pages**
2. **Source**: Deploy from a branch
3. **Branch**: `main`, folder `/docs`
4. Save

After the first deploy, the site is at `https://jpogah.github.io/fork-and-go/`.

## Promoting to a custom domain (later)

When a custom domain is wanted (e.g. `forkandgo.dev`):

1. Add a `CNAME` file in this folder with the domain on a single line.
2. Configure the domain's DNS: either four `A` records pointing at GitHub's Pages IPs, or a `CNAME` record on the apex/subdomain pointing at `jpogah.github.io`.
3. In the repo's **Settings → Pages**, enter the custom domain and enable HTTPS.
