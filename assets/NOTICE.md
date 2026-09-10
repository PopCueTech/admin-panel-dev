# Asset attribution

## `us-states-10m.json`

US states TopoJSON from **us-atlas** (`https://github.com/topojson/us-atlas`),
file `states-10m.json` (`us-atlas@3`).

- Derived from the US Census Bureau cartographic boundary files (public domain).
- us-atlas package licence: ISC.
- Used by the Geographic distribution admin page to draw the state choropleth
  (`admin-panel/geo.js`). State polygons carry `properties.name` (full state
  name, e.g. `"Texas"`), which is how counts from `/api/v1/admin/users/by-location`
  are joined to the map.
