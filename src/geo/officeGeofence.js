/**
 * Single source of truth for the office's geofence coordinates/radius and
 * the haversine distance calculation used to check against them.
 * Previously duplicated (both the constants and the distance formula)
 * between AttendanceView's continuous GPS watch and, now, the one-shot
 * check App.jsx runs to decide whether an auto clock-in-on-login is
 * inside the office radius -- a single copy means the two can never
 * silently drift apart.
 */
export const OFFICE_LOCATION = { lat: -6.20651363, lng: 106.87604852 };
export const ALLOWED_RADIUS_METERS = 100;

/** Great-circle distance between two lat/lng points, in meters. */
export function calculateDistanceMeters(lat1, lng1, lat2, lng2) {
    const earthRadiusMeters = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusMeters * c;
}
