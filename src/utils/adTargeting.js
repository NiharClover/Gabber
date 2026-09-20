function haversineDistance(lat1, lng1, lat2, lng2) {
  const radiusKm = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isAdEligible(ad, context) {
  const hasGeoTarget = ad.target_lat != null && ad.target_lng != null;
  const hasCityTarget = Boolean(ad.target_city);
  const hasPincodeTarget = Boolean(ad.target_pincode);
  if (!hasGeoTarget && !hasCityTarget && !hasPincodeTarget) return true;

  const matches = [];
  if (hasPincodeTarget) {
    matches.push(Boolean(context.pincode) && ad.target_pincode === context.pincode);
  }
  if (hasCityTarget) {
    matches.push(Boolean(context.city) && ad.target_city.toLowerCase() === context.city);
  }
  if (hasGeoTarget) {
    matches.push(context.hasCoordinates
      && haversineDistance(context.lat, context.lng, Number(ad.target_lat), Number(ad.target_lng)) <= Number(ad.target_radius_km || 5));
  }
  return matches.some(Boolean);
}

module.exports = { haversineDistance, isAdEligible };
