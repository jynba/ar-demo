# ar-demo

Dynamic AR.js NFT target verification for a fixed Trex model.

## What changed

- Added a local Node server at `server/index.js`
- Added `POST /api/targets` to build `.iset/.fset/.fset3` from an image URL or uploaded file
- Added `GET /api/targets/:id` for task metadata
- Added `GET /viewer/:id` for a ready-to-scan AR page
- Kept the AR content fixed to the Trex model while letting the NFT target image change per request

## Prerequisites

The project expects the official generator at:

- `vendor/NFT-Marker-Creator`

The current implementation already uses that folder and runs its `app.js` through Node.

## Run

```bash
npm start
```

Open:

```text
http://localhost:3030
```

## API

### Create from image URL

```bash
curl -X POST http://localhost:3030/api/targets \
  -H 'Content-Type: application/json' \
  -d '{"image_url":"http://localhost:3030/asset/test.jpg"}'
```

### Create from local upload

```bash
curl -X POST http://localhost:3030/api/targets \
  -F image=@./dist/asset/test.jpg
```

### Get task metadata

```bash
curl http://localhost:3030/api/targets/<task_id>
```

## Runtime output

Generated files are written under:

```text
runtime/targets/<taskId>/
```

Each task stores:

- `<taskId>.iset`
- `<taskId>.fset`
- `<taskId>.fset3`
- `<taskId>.jpg` or `<taskId>.png`
- `meta.json`

## Notes

- This is a POC for dynamic NFT target generation, not a production deployment.
- The target image changes per request, but the scanned AR content always stays the same Trex model.
- Best results come from images with strong feature points, contrast, and detail.
