/**
 * NOVABALL render-world — holo scoreboard canvas (redrawn only when the displayed values change).
 */
import { CanvasTexture, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';
import { TEAMS } from '../../theme';
import { DISPLAY_FONT } from './Floor';

export class ScoreboardCanvas {
  readonly texture: CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  private drawn = false;
  private readonly last: { score: [number, number]; clock: number; secs: number; overtime: boolean } = { score: [0, 0], clock: 180, secs: 180, overtime: false };

  constructor(width = 1024, height = 448) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.g = this.canvas.getContext('2d');
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    // mipmapped: the 1024 px canvas is shown at ~180-330 px on the rotating holo cube (no shimmering text);
    // the canvas is redrawn at most once per second, so regenerating the mips is negligible
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
    this.draw([0, 0], 180, false, true);
  }

  /** Displayed whole seconds: regulation counts DOWN (ceil), overtime counts UP (floor) — same as the HUD. */
  static displaySeconds(clock: number, overtime: boolean): number {
    return overtime ? Math.floor(Math.max(0, clock)) : Math.max(0, Math.ceil(clock - 1e-6));
  }

  static formatClock(clock: number, overtime: boolean): string {
    const t = ScoreboardCanvas.displaySeconds(clock, overtime);
    const m = Math.floor(t / 60);
    const s = t % 60;
    return `${overtime ? '+' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

  /** Returns true when the canvas was redrawn. Allocation-free when nothing changed. */
  draw(score: [number, number], clock: number, overtime: boolean, force = false): boolean {
    const secs = ScoreboardCanvas.displaySeconds(clock, overtime);
    const l = this.last;
    if (!force && this.drawn && l.score[0] === score[0] && l.score[1] === score[1] && l.secs === secs && l.overtime === overtime) return false;
    l.score[0] = score[0];
    l.score[1] = score[1];
    l.clock = clock;
    l.secs = secs;
    l.overtime = overtime;
    this.drawn = true;
    const clockStr = ScoreboardCanvas.formatClock(clock, overtime);
    const g = this.g;
    if (!g) return false;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    // backdrop
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(6,10,26,0.96)');
    bg.addColorStop(1, 'rgba(2,4,12,0.96)');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    // team panels
    const c0 = TEAMS[0].primary;
    const c1 = TEAMS[1].primary;
    const grad0 = g.createLinearGradient(0, 0, W * 0.5, 0);
    grad0.addColorStop(0, hexA(c0, 0.55));
    grad0.addColorStop(1, hexA(c0, 0.0));
    g.fillStyle = grad0;
    g.fillRect(0, 0, W * 0.5, H);
    const grad1 = g.createLinearGradient(W, 0, W * 0.5, 0);
    grad1.addColorStop(0, hexA(c1, 0.55));
    grad1.addColorStop(1, hexA(c1, 0.0));
    g.fillStyle = grad1;
    g.fillRect(W * 0.5, 0, W * 0.5, H);
    // frame
    g.strokeStyle = 'rgba(160,200,255,0.9)';
    g.lineWidth = 6;
    g.strokeRect(8, 8, W - 16, H - 16);
    g.fillStyle = 'rgba(160,200,255,0.9)';
    g.fillRect(W * 0.5 - 150, 8, 300, 10);
    // names
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.font = `900 64px ${DISPLAY_FONT}`;
    g.fillStyle = TEAMS[0].secondary;
    g.fillText(TEAMS[0].name, W * 0.2, H * 0.2);
    g.fillStyle = TEAMS[1].secondary;
    g.fillText(TEAMS[1].name, W * 0.8, H * 0.2);
    // scores
    g.font = `900 220px ${DISPLAY_FONT}`;
    g.fillStyle = '#ffffff';
    g.shadowColor = c0;
    g.shadowBlur = 30;
    g.fillText(String(score[0]), W * 0.2, H * 0.62);
    g.shadowColor = c1;
    g.fillText(String(score[1]), W * 0.8, H * 0.62);
    g.shadowBlur = 0;
    // clock
    g.font = `700 92px ${DISPLAY_FONT}`;
    g.fillStyle = overtime ? '#ffd166' : '#e8f2ff';
    g.fillText(clockStr, W * 0.5, H * 0.5);
    g.font = `700 36px ${DISPLAY_FONT}`;
    g.fillStyle = 'rgba(200,220,255,0.75)';
    g.fillText(overtime ? 'OVERTIME' : 'NOVABALL', W * 0.5, H * 0.77);
    this.texture.needsUpdate = true;
    return true;
  }

  /** Force a redraw with the last values (e.g. after fonts load). */
  redraw(): void {
    this.draw(this.last.score, this.last.clock, this.last.overtime, true);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function hexA(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}
