# Separate Sales UX

Standalone Node/Express UX for browsing sales data and using persistent chat.

## Run

1. Install deps:

```bash
npm install
```

2. Start:

```bash
NODE_API_BASE_URL=http://localhost:8787 NODE_API_KEY=your_key npm start
```

`NODE_API_KEY` is applied server-side by the UX proxy and is not exposed to browser JavaScript.

3. Open:

- [http://localhost:8790](http://localhost:8790)

## Environment

- `PORT` (default `8790`)
- `NODE_API_BASE_URL` (default `http://localhost:8787`)
- `NODE_API_KEY` (recommended; used server-side by the proxy, should match backend `NODE_API_KEY`)
