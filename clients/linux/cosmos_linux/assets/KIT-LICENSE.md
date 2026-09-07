# Omarchy UI kit provenance

The graphics and theme tokens in this directory come from the Cosmos Omarchy UI kit (kit version 1.0.0). The kit's notes follow verbatim.

# Use and provenance

The newly authored code in this kit may be used, modified and redistributed under the MIT license below. The reconstructed visual assets are based on the user-supplied photo and the earlier generated Android kit. This does not establish exclusive ownership of the Cosmos name/mark or grant rights in unrelated trademarks. See ASSET-NOTES.md before public distribution.

No font files or external dependency binaries are included. SwiftUI/AppKit, AndroidX, Qt/PySide and build tools remain subject to their own terms and licenses when obtained separately. In particular, review Qt/PySide licensing for your intended distribution; this kit does not relicense those libraries.

## MIT License — newly authored code only

Copyright (c) 2026 Cosmos UI kit contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# Asset provenance and scaling
The crescent silhouette, seven-bar identity, palette and isolated nebula originate in the earlier Cosmos Android kit supplied in this conversation. The photo is the visual reference, not a source file recovery. The later design-sheet posters are not used as production artwork and their text is not treated as a technical specification.

All response panels are blank. Nebula textures have real alpha and contain no text, phone frame or waveform. Waveforms and icons are separate SVG/PNG files. Render responses and controls as native text/components. The Android TV launcher banner intentionally includes the app name because it is a launcher branding asset, not assistant response text.

The source nebula is 1536 × 512. 1920/3840 backgrounds are layout-size composites/resampling, not new native-detail 4K artwork. Keep full-screen backgrounds optional; the shipped TV component uses the smaller transparent texture.

Panels have 20 logical pixels of outer glow padding. Use the cap insets in design-tokens.json for raster nine-slicing or the supplied native geometry. Do not stretch a full panel bitmap uniformly. SVG filters are presentation effects, not Android VectorDrawable features. Android resources include an actual NinePatch alternative.

No fonts, Apple UI artwork, Google marks or Omarchy trademarks are bundled. Native samples use system fonts. The reconstructed Cosmos identity is not a trademark-clearance claim. Name/identity clearance is your responsibility before distribution.
