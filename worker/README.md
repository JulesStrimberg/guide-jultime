# Luc-IA — Worker Cloudflare

Le site n'appelle plus Groq directement : il envoie seulement la recherche
(`{ "query": "..." }`) à ce Worker, qui garde la clé Groq en secret, lit le
Google Sheet publié, construit le prompt et renvoie `{ "recs": [...] }`.

Protections :
- clé Groq stockée en secret Cloudflare (`GROQ_API_KEY`), jamais dans le site ;
- seules les pages de `https://julesstrimberg.github.io` peuvent l'appeler ;
- recherche limitée à 200 caractères, modèle et prompt fixés côté Worker ;
- 10 questions par minute et par IP (si déployé avec `wrangler.toml`).

## Déployer depuis le tableau de bord Cloudflare (sans terminal)

1. dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**.
   Nom : `luc-ia` → **Deploy**.
2. **Edit code** → remplacer tout le contenu par `luc-ia.js` → **Deploy**.
3. **Settings** → **Variables and Secrets** → **Add** → type **Secret**,
   nom `GROQ_API_KEY`, valeur = la nouvelle clé Groq → **Deploy**.
4. Noter l'URL du Worker (`https://luc-ia.<ton-sous-domaine>.workers.dev`)
   et la mettre dans `LUCIA_URL` dans `index.html`.

La limite de 10 questions/minute n'est active qu'avec le déploiement en ligne
de commande ci-dessous (le reste fonctionne pareil).

## Déployer en ligne de commande

```sh
cd worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put GROQ_API_KEY
```
