Pinned third-party libraries, served from the site so it doesn't depend on a CDN
(and can work offline). Update by re-downloading the same paths from unpkg.com.

- maplibre-gl 4.7.1 (`dist/maplibre-gl.js`, `dist/maplibre-gl.css`): BSD-3-Clause, see `maplibre-gl@4.7.1.LICENSE.txt`
- flatgeobuf 3.36.0 (`dist/flatgeobuf-geojson.min.js`): BSD-2-Clause, see `flatgeobuf@3.36.0.LICENSE.txt`
- tz-lookup 6.1.25 (`tz.js`): CC0-1.0 (public domain)
- ol (OpenLayers) 10.4.0 (`dist/ol.js`, `ol.css`): BSD-2-Clause, see `ol@10.4.0.LICENSE.txt`; polar views only, loaded on demand
- proj4 2.15.0 (`dist/proj4.js`): MIT, see `proj4@2.15.0.LICENSE.txt`
