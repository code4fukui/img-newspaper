# img-newspaper

> 日本語のREADMEはこちらです: [README.ja.md](README.ja.md)

A WebGL-based image filter that applies a newspaper-style halftone effect using a custom `<img-newspaper>` HTML element.

## Demo

[**Live Demo**](https://code4fukui.github.io/img-newspaper/)

The interactive demo allows you to upload an image and adjust all filter parameters in real-time.

## Features

- **Halftone Effect:** Applies a classic newspaper-style monochrome halftone effect.
- **Highly Customizable:** Adjust dot size, screen angle, contrast, and gamma.
- **Analog Imperfections:** Simulate ink bleed, paper grain, and a vignette effect for an authentic look.
- **Custom Colors:** Set custom paper and ink colors.
- **Responsive:** Automatically fits the image to the element's size while preserving the aspect ratio.
- **Easy Integration:** Use as a simple HTML custom element or via a JavaScript API.
- **Export:** The rendered image can be downloaded as a PNG (feature available in the demo).

## Requirements

A modern web browser with WebGL support.

## Usage

### As a Custom HTML Element

Include the script from a CDN and use the `<img-newspaper>` tag in your HTML.

```html
<script type="module" src="https://code4fukui.github.io/img