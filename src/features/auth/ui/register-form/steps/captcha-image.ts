const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Image source for the registration captcha SVG.
 *
 * The captcha comes from rotating third-party Pocketnet proxy nodes and used to
 * be inserted with v-html after a regex clean-up that let an unquoted handler
 * (`<svg onload=alert(1)>`) through (audit S10-02, S5-04). As an `<img>` source
 * the SVG is rendered as a picture: scripts, event handlers and external loads
 * never run, whatever the markup holds. An `<img>` needs the SVG namespace on
 * the root element, so it is added when the markup omits it.
 */
export function captchaImageSrc(svg: string): string {
  // A BOM or an XML prolog before <svg> would hide the root from the namespace check.
  const markup = svg.replace(/^﻿/, "").trim().replace(/^<\?xml[^>]*\?>\s*/i, "");
  if (!markup) return "";
  const namespaced = /^<svg\b[^>]*\sxmlns\s*=/i.test(markup)
    ? markup
    : markup.replace(/^<svg\b/i, `<svg xmlns="${SVG_NS}"`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(namespaced)}`;
}
