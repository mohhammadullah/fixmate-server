
// Approximate distance between two coordinates (haversine), in km.
// Used for service/technician matching only — never to expose precise
// coordinates. Distances are rounded to one decimal for display.

export interface Coordinates {
  lat: number;
  lng: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export const haversineKm = (a: Coordinates, b: Coordinates): number => {
  const R = 6371; // Earth radius in km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
};

export const isValidLatLng = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

/** Round a distance for display — never reveals exact position. */
export const roundDistanceKm = (km: number): number =>
  Math.max(0, Math.round(km * 10) / 10);
