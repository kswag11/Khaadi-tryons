# Nool Khadi Try-On

A browser-based 3D fitting room for contemporary Kerala khadi. Visitors pick a male or female model, try six outfits each, change the main and second colour from a natural-dye palette, change skin tone, spin the model and save a snapshot. Built for the Khadi revitalisation assignment (Part II multimedia element).

## What's in it

- **Sculpted models.** Male and female figures with modelled anatomy (shoulders, chest, waist, hips, knees and calves), faces (eyes with irises, lids, brows, nose, lips, ears), hands with fingers and thumbs, hair (a textured crop; a long braid with optional jasmine), and mojari/jutti footwear. Four skin tones.
- **Draped garments.** Kurta and pyjama, Nehru jacket set, short kurta-shirt, oversized tee co-ord, mundu and shirt, and kasavu kurta. Kurta and palazzo with dupatta, kasavu pavada set, kasavu saree with pleats and pallu, co-ord set, A-line dress, and a jacket over a kurti. Cloth hangs from the chest or hips with folds, side slits, open fronts, hollow hems and cuffs, gold kasavu borders and buttons.
- **Fabric look.** Ten khadi colours on a procedural hand-spun weave texture, with cloth sheen and baked ambient occlusion for soft contact shadows.
- **Weaver card.** Shows the price and an illustrative split of what goes to the weaver and the spinner.
- **Controls.** Drag to rotate, scroll or pinch to zoom, auto-rotate, face close-up, and snapshot to PNG.

There are no 3D model files. Every body and garment is sculpted in code as a signed distance field and turned into a mesh in your browser.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page structure and the Three.js import map (loads Three.js 0.160 from the jsDelivr CDN) |
| `style.css` | Layout, light and dark theme |
| `app.js` | Scene, lighting, materials, UI, worker pool |
| `tailor.js` | The sculpting engine: body measurements, face, hands, hair, garments, and the surface-nets mesher |
| `worker.js` | Runs `tailor.js` in background threads so the page stays responsive |

## Performance

The first load takes about 5–15 seconds while the models are sculpted. After that, colour changes are instant. Every other outfit keeps building in the background, so it is usually ready by the time you click it. Expect about 3–6 seconds per outfit on a laptop if you click one that isn't built yet. Phones are slower.

## Run it locally

ES modules and Web Workers don't load from `file://`, so serve the folder:

```bash
cd khadi-tryon
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy on GitHub Pages

1. Create a new **public** repository, for example `nool-khadi-tryon`.
2. Upload all five code files (`index.html`, `style.css`, `app.js`, `tailor.js`, `worker.js`) and this README to the **root** of the repo. They must sit at the top level, not inside a folder.
3. Go to **Settings → Pages**, set **Source** to "Deploy from a branch", choose branch `main` and folder `/ (root)`, and save.
4. After a minute or two the site is live at `https://<your-username>.github.io/nool-khadi-tryon/`.

## Customise

- **Colours:** edit `PALETTE` in `app.js`.
- **Outfit names, prices and default colours:** edit `OUTFITS` in `app.js`.
- **Garment shapes:** edit `OUTFIT_DEFS` in `tailor.js`. Each outfit is a list of pieces (`top`, `sleeves`, `trousers`, `skirt`, `collar`, `ribbon`) with parameters such as `hem`, `ease` (looseness), `flare`, `folds`, `slit`, `open` and `border`.
- **Body proportions:** edit `MALE` and `FEMALE` in `tailor.js`.
- **Weaver names:** `WEAVERS` in `app.js` holds illustrative names. Only swap in real units with their consent.

## Credits

Three.js (MIT licence) is loaded from jsDelivr. Fonts are Fraunces and Inter from Google Fonts.
