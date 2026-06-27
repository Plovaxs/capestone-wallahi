import React from "react";
import { MapContainer, TileLayer, Marker, Polygon, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Fix default icon problem in Leaflet
delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

export default function OfficeMap({ userLocation, polygon, inside }) {
  if (!userLocation) return <p className="text-gray-400">Loading map…</p>;

  return (
    <MapContainer
      center={[userLocation.lat, userLocation.lon]}
      zoom={17}
      scrollWheelZoom={false}
      className="rounded-lg shadow-lg h-[300px] w-full"
    >
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

      {/* Office polygon */}
      <Polygon
        positions={polygon.map((p) => [p.lat, p.lon])}
        pathOptions={{ color: inside ? "green" : "red" }}
      />

      {/* User marker */}
      <Marker position={[userLocation.lat, userLocation.lon]}>
        <Popup>
          <b>Your Location</b>
          <br />
          {inside ? "Inside Bea Cukai Area" : "Outside Area"}
        </Popup>
      </Marker>
    </MapContainer>
  );
}
