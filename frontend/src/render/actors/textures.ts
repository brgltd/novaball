/**
 * Canvas-generated textures for the actor views (no external assets).
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, type Texture } from 'three';

let glowTex: CanvasTexture | null = null;

/** Shared soft radial glow (white, premultiplied-friendly falloff). Never disposed per view. */
export function getGlowTexture(): Texture {
  if (glowTex) return glowTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.12, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.32)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.1)');
  grd.addColorStop(0.8, 'rgba(255,255,255,0.025)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  glowTex = new CanvasTexture(c);
  glowTex.colorSpace = SRGBColorSpace;
  glowTex.minFilter = LinearMipmapLinearFilter;
  glowTex.magFilter = LinearFilter;
  return glowTex;
}

let raysTex: CanvasTexture | null = null;

/** Shared star-flare texture: soft core + 8 tapered rays (SUPERNOVA corona). */
export function getRaysTexture(): Texture {
  if (raysTex) return raysTex;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  g.globalCompositeOperation = 'lighter';
  const rays = 8;
  for (let i = 0; i < rays; i++) {
    const long = i % 2 === 0;
    const len = (size / 2) * (long ? 0.98 : 0.62);
    const w = long ? 7 : 5;
    g.save();
    g.rotate((i / rays) * Math.PI * 2);
    const grd = g.createLinearGradient(0, 0, len, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, -w);
    g.quadraticCurveTo(len * 0.5, -w * 0.35, len, 0);
    g.quadraticCurveTo(len * 0.5, w * 0.35, 0, w);
    g.closePath();
    g.fill();
    g.restore();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, size * 0.22);
  core.addColorStop(0, 'rgba(255,255,255,0.8)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core;
  g.fillRect(-size / 2, -size / 2, size, size);
  raysTex = new CanvasTexture(c);
  raysTex.colorSpace = SRGBColorSpace;
  raysTex.minFilter = LinearMipmapLinearFilter;
  raysTex.magFilter = LinearFilter;
  return raysTex;
}

const NAME_FONT_STACK = "'Orbitron', 'Rajdhani', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

/** Draws a car nameplate (skewed glass plate, team accent, name). Redraws when web fonts finish loading. */
export class NameplateTexture {
  readonly texture: CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private disposed = false;

  constructor(
    private readonly name: string,
    private readonly teamHex: string,
    private readonly isBot: boolean,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 128;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.anisotropy = 4;
    this.draw();
    const fonts = (typeof document !== 'undefined' ? document.fonts : undefined) as FontFaceSet | undefined;
    if (fonts && typeof fonts.load === 'function') {
      fonts
        .load("700 56px 'Orbitron'")
        .then(() => {
          if (!this.disposed && fonts.check("700 56px 'Orbitron'")) {
            this.draw();
            this.texture.needsUpdate = true;
          }
        })
        .catch(() => undefined);
    }
  }

  private draw(): void {
    const g = this.canvas.getContext('2d')!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const text = this.name.toUpperCase().slice(0, 14);
    let fontPx = 50;
    g.font = `700 ${fontPx}px ${NAME_FONT_STACK}`;
    let tw = g.measureText(text).width;
    const maxText = W - 150;
    if (tw > maxText) {
      fontPx = Math.floor((fontPx * maxText) / tw);
      g.font = `700 ${fontPx}px ${NAME_FONT_STACK}`;
      tw = g.measureText(text).width;
    }
    const plateW = Math.min(W - 16, tw + 110);
    const plateH = 70;
    const x0 = (W - plateW) / 2;
    const y0 = 14;
    const skew = 16;
    // plate
    g.beginPath();
    g.moveTo(x0 + skew, y0);
    g.lineTo(x0 + plateW, y0);
    g.lineTo(x0 + plateW - skew, y0 + plateH);
    g.lineTo(x0, y0 + plateH);
    g.closePath();
    const bg = g.createLinearGradient(0, y0, 0, y0 + plateH);
    bg.addColorStop(0, 'rgba(10,16,30,0.78)');
    bg.addColorStop(1, 'rgba(4,7,14,0.86)');
    g.fillStyle = bg;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.stroke();
    // team accent: left block + bottom rule
    g.fillStyle = this.teamHex;
    g.beginPath();
    g.moveTo(x0 + skew, y0);
    g.lineTo(x0 + skew + 16, y0);
    g.lineTo(x0 + 16, y0 + plateH);
    g.lineTo(x0, y0 + plateH);
    g.closePath();
    g.fill();
    g.fillRect(x0 + 8, y0 + plateH - 4, plateW - 24, 4);
    // name
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = this.teamHex;
    g.shadowBlur = 14;
    g.fillStyle = '#f4f8ff';
    g.fillText(text, W / 2 + 6, y0 + plateH / 2 + 2);
    g.shadowBlur = 0;
    // bot tag
    if (this.isBot) {
      g.font = `700 16px ${NAME_FONT_STACK}`;
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.textAlign = 'right';
      g.fillText('BOT', x0 + plateW - 22, y0 + 14);
    }
    // pointer chevron
    g.fillStyle = this.teamHex;
    g.beginPath();
    g.moveTo(W / 2 - 13, y0 + plateH + 10);
    g.lineTo(W / 2 + 13, y0 + plateH + 10);
    g.lineTo(W / 2, y0 + plateH + 24);
    g.closePath();
    g.fill();
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
  }
}
