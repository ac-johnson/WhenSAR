// Polar stereographic map views (Arctic EPSG:3413, Antarctic EPSG:3031) with OpenLayers and
// NASA GIBS basemap tiles. MapLibre only draws Web Mercator, so these views use a second
// library, loaded on first use to keep the default page light.

const VIEWS = {
  arctic: {
    code: "EPSG:3413",
    def: "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
    gibs: "epsg3413",
  },
  antarctic: {
    code: "EPSG:3031",
    def: "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
    gibs: "epsg3031",
  },
};
// GIBS polar tile grid (both poles): 512 px tiles from the top-left corner, 8192-512 m/px
const EXTENT = [-4194304, -4194304, 4194304, 4194304];
const RESOLUTIONS = [8192, 4096, 2048, 1024, 512];
const COLORS = { A: "#2563eb", D: "#d9480f" };

let libs = null;
function loadLibs() {
  const script = (src) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.append(s);
  });
  libs ??= (async () => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "vendor/ol.css";
    document.head.append(css);
    await Promise.all([script("vendor/ol.js"), script("vendor/proj4.js")]);
    for (const v of Object.values(VIEWS)) proj4.defs(v.code, v.def);
    ol.proj.proj4.register(proj4);
  })();
  return libs;
}

export async function createPolarMap(container, pole, { onClick }) {
  await loadLibs();
  const v = VIEWS[pole];
  const projection = ol.proj.get(v.code);
  projection.setExtent(EXTENT);

  const base = new ol.layer.Tile({
    source: new ol.source.WMTS({
      url: `https://gibs.earthdata.nasa.gov/wmts/${v.gibs}/best/BlueMarble_ShadedRelief_Bathymetry/default/default/500m/{TileMatrix}/{TileRow}/{TileCol}.jpeg`,
      requestEncoding: "REST",
      layer: "BlueMarble_ShadedRelief_Bathymetry",
      matrixSet: "500m",
      format: "image/jpeg",
      style: "default",
      projection,
      tileGrid: new ol.tilegrid.WMTS({
        origin: [EXTENT[0], EXTENT[3]],
        resolutions: RESOLUTIONS,
        matrixIds: RESOLUTIONS.map((_, i) => String(i)),
        tileSize: 512,
      }),
      wrapX: false,
      attributions: 'Imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>',
    }),
  });

  let selectedKey = null;
  const footprints = new ol.source.Vector();
  const footprintLayer = new ol.layer.Vector({
    source: footprints,
    style: (f) => {
      const selected = f.get("key") === selectedKey;
      const color = COLORS[f.get("dir")] || COLORS.A;
      return new ol.style.Style({
        stroke: new ol.style.Stroke({ color, width: selected ? 2.5 : 1, lineDash: f.get("planned") ? [6, 4] : undefined }),
        fill: new ol.style.Fill({ color: color + (selected ? "40" : "12") }),
        zIndex: selected ? 1 : 0,
      });
    },
  });
  const point = new ol.source.Vector();
  const pointLayer = new ol.layer.Vector({
    source: point,
    style: new ol.style.Style({
      image: new ol.style.Circle({ radius: 7, fill: new ol.style.Fill({ color: "#16181d" }), stroke: new ol.style.Stroke({ color: "#fff", width: 2.5 }) }),
    }),
  });

  const map = new ol.Map({
    target: container,
    layers: [base, footprintLayer, pointLayer],
    view: new ol.View({ projection, center: [0, 0], resolution: 8192, maxResolution: 16384, extent: EXTENT, constrainOnlyCenter: true }),
    controls: ol.control.defaults.defaults({ rotate: false, attributionOptions: { collapsible: true } }),
  });
  map.on("click", (e) => {
    const [lon, lat] = ol.proj.toLonLat(e.coordinate, projection);
    onClick(lon, lat);
  });
  const geojson = new ol.format.GeoJSON({ dataProjection: "EPSG:4326", featureProjection: projection });

  return {
    resize: () => map.updateSize(),
    setPoint(lonlat) {
      point.clear();
      if (lonlat) point.addFeature(new ol.Feature(new ol.geom.Point(ol.proj.fromLonLat(lonlat, projection))));
    },
    setFootprints(features) {
      footprints.clear();
      footprints.addFeatures(geojson.readFeatures({ type: "FeatureCollection", features }));
    },
    highlight(key) {
      selectedKey = key;
      footprintLayer.changed();
    },
    fit(padding, fitFootprints) {
      const view = map.getView();
      const pad = [padding.top, padding.right, padding.bottom, padding.left];
      if (fitFootprints && footprints.getFeatures().length) {
        view.fit(footprints.getExtent(), { padding: pad, duration: 600 });
      } else if (point.getFeatures().length) {
        // A lone point has no size to fit; show ~1500 km around it, offset for the panel
        const c = ol.extent.getCenter(point.getExtent());
        const res = 2000;
        view.animate({ center: [c[0] - ((pad[1] - pad[3]) / 2) * res, c[1] - ((pad[0] - pad[2]) / 2) * res], resolution: res, duration: 600 });
      }
    },
  };
}
