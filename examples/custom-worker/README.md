# A relay in your own Worker

The stock relay plus two rules: a page at `/`, and at most ten new rooms a minute from one address. Add yours in `src/index.ts` before the call to `handleRelay`.

```sh
npm install
npm run dev
npx wrangler secret put PAIRLOBBY_CREATE_TOKEN   # before you deploy
npm run deploy
```

Outside this repository, depend on the published package instead: `npm install @pairlobby/durable-runtime`.
