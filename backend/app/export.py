from __future__ import annotations

from datetime import timezone
from xml.etree.ElementTree import Element, SubElement, tostring

from app.models import Track


def export_gpx(track: Track) -> bytes:
    gpx = Element("gpx", attrib={"version": "1.1", "creator": "gps-track-repair", "xmlns": "http://www.topografix.com/GPX/1/1"})
    trk = SubElement(gpx, "trk")
    if track.name:
        SubElement(trk, "name").text = track.name
    seg = SubElement(trk, "trkseg")
    for p in track.points:
        trkpt = SubElement(seg, "trkpt", attrib={"lat": f"{p.lat:.7f}", "lon": f"{p.lon:.7f}"})
        if p.ele is not None:
            SubElement(trkpt, "ele").text = f"{p.ele:.2f}"
        if p.time is not None:
            ts = p.time if p.time.tzinfo else p.time.replace(tzinfo=timezone.utc)
            SubElement(trkpt, "time").text = ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    xml = tostring(gpx, encoding="utf-8", xml_declaration=True)
    return xml


def export_kml(track: Track) -> bytes:
    kml = Element("kml", attrib={"xmlns": "http://www.opengis.net/kml/2.2"})
    doc = SubElement(kml, "Document")
    if track.name:
        SubElement(doc, "name").text = track.name
    placemark = SubElement(doc, "Placemark")
    SubElement(placemark, "name").text = track.name or "Repaired track"
    line = SubElement(placemark, "LineString")
    SubElement(line, "tessellate").text = "1"
    coords = []
    for p in track.points:
        if p.ele is not None:
            coords.append(f"{p.lon:.7f},{p.lat:.7f},{p.ele:.2f}")
        else:
            coords.append(f"{p.lon:.7f},{p.lat:.7f},0")
    SubElement(line, "coordinates").text = " ".join(coords)
    return tostring(kml, encoding="utf-8", xml_declaration=True)


def export_track(track: Track, fmt: str) -> tuple[bytes, str, str]:
    fmt = fmt.lower().lstrip(".")
    if fmt == "gpx":
        return export_gpx(track), "application/gpx+xml", "repaired.gpx"
    if fmt == "kml":
        return export_kml(track), "application/vnd.google-earth.kml+xml", "repaired.kml"
    raise ValueError("Supported export formats: gpx, kml")
