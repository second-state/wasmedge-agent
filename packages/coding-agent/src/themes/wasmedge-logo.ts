/**
 * Pre-rendered ASCII versions of the brand butterfly mark.
 *
 * The mark itself is still upstream's, renamed but not redrawn -- see the
 * dated note inside the source SVG.
 *
 * Source: assets/brand/wasmedge-butterfly.svg
 * Re-render at any width: `uv run scripts/render-logo.py --width N`
 */

/** ~10 rows × 32 cols. The default brand mark — half-block butterfly, splash-ready. */
export const WASMEDGE_BUTTERFLY_LOGO = `                          ▄▄███▀
    ▄▄▄▄▄              ▄█████▀
    ██████▄         ▄██████▀
   ▄███▀███▄     ▄███▀▄██▀
   ███ ▄████▄▄▄████▀▄▄██
  ▀██  ▀█████████▀▀▀▀▀▀
  ▄██   ██████▀▀ ▄███
 █████    ▀█▄▄▄█████▀
███████▄  ████████▀
▀███▀▀    █████▀`;
