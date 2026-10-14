# Globe land dots

`globe-land-dots.bin` is generated from Natural Earth's 1:110m land polygons.
Natural Earth map data is in the public domain:
https://www.naturalearthdata.com/about/terms-of-use/

Pinned source:
https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_110m_land.geojson

Regenerate from the project root with:

```sh
node scripts/generate-globe-land-dots.mjs
```

The binary stores a big-endian 32-bit point count followed by signed 16-bit
latitude/longitude pairs in hundredths of a degree. The land dots are decorative,
not a source of precise geographic or routing information.
